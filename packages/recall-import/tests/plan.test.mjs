import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildAtlas } from '../../atlas-index/src/index.mjs';
import { checkSource, recallSource, toNotes, sources, limits } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';

const time = '2026-11-05T12:00:00.000Z';
const sha = text => createHash('sha256').update(text).digest('hex');
const item = key => ({ key, title: key, body: 'Invented body', tags: [], url: null, created: null, sourcePath: key });
const source = recallSource();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-plan-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas');
  fs.mkdirSync(input);
  const put = (key, text = '# Invented\n') => { const file = path.join(input, key); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const argv = ['--in', input, '--atlas', atlas, '--imported-at', time, '--write'];
  return { root, input, atlas, put, argv, run: options => runImport(argv, options), dir: path.join(atlas, 'sources/recall') };
}
function manifestMatches(f) {
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json')));
  assert.deepEqual(manifest.pending, {});
  for (const entry of Object.values(manifest.entries)) assert.equal(sha(fs.readFileSync(path.join(f.atlas, entry.path))), entry.fullHash);
}

test('Plan 1: sample export matches expected notes byte for byte', () => {
  const root = new URL('../sample-export/', import.meta.url);
  const files = ['welcome.md', 'nested/heading-card.md', 'not-a-card.txt'].map(name => ({ path: name, text: fs.readFileSync(new URL(name, root), 'utf8') }));
  const result = checkSource(source, files);
  const { notes } = toNotes(result.items, { source, importedAt: time });
  assert.deepEqual(notes.map(n => n.text), [
    `---\nkind: source\ntitle: Invented Welcome Card\ndescription: Invented Welcome Card\nsource: Recall\nlabel: from a source\nstatus: unchecked\nimported: ${time}\ntags:\n  - sample\n  - invented\nrecall:\n  topic: examples\n---\n\nThis is an invented card used by the package tests.\n`,
    `---\nkind: source\ntitle: Nested Invented Card\ndescription: Nested Invented Card\nsource: Recall\nlabel: from a source\nstatus: unchecked\nimported: ${time}\n---\n\n# Nested Invented Card\n\nAn invented nested card with [an image](https://example.invalid/image.png).\n\nImages in this card were not imported. Their links may stop working.\n`
  ]);
  assert.equal(result.skipped.length, 1);
});

test('Plan 2: front matter, heading and filename precedence and malformed preservation', () => {
  const raw = '---\ntitle: Metadata\nurl: https://example.invalid/a\nsource: fallback\ntags: [a, b]\ncreated: first\ndate: second\ncustom: retained\n---\n# Heading\n';
  const result = checkSource(source, [{ path: 'file.md', text: raw }, { path: 'heading.md', text: '# Heading\n' }, { path: 'filename.md', text: 'body' }, { path: 'bad.md', text: '---\nbad\n---\nbody' }]);
  assert.deepEqual(result.items.map(i => i.title), ['Metadata', 'Heading', 'filename', 'bad']);
  assert.equal(result.items[0].url, 'https://example.invalid/a'); assert.equal(result.items[0].created, 'first');
  assert.deepEqual(result.items[0].tags, ['a', 'b']); assert.deepEqual(result.items[0].extra, { custom: 'retained' });
  assert.equal(result.items[3].body, '---\nbad\n---\nbody'); assert.match(result.warnings[0], /bad.md/);
});

test('Plan 3: image becomes plain text link and network attempts fail', () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  try {
    const result = checkSource(source, [{ path: 'image.md', text: '![Invented](https://example.invalid/p.png)' }]);
    const text = toNotes(result.items, { source, importedAt: time }).notes[0].text;
    assert.match(text, /\[Invented\]\(https:\/\/example.invalid\/p.png\)/); assert.doesNotMatch(text, /!\[/);
    assert.match(text, /Images in this card were not imported/);
    const code = fs.readFileSync(new URL('../src/import.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/sources.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(code, /(?:fetch\s*\(|node:(?:http|https|net|tls|dns|dgram))/);
  } finally { globalThis.fetch = previous; }
});

test('Plan 4: card, count and total limits report and refuse before writing', () => {
  const f = fixture();
  assert.match(source.read([{ path: 'large.md', text: 'x'.repeat(limits.cardBytes + 1) }]).skipped[0].reason, /1048577 bytes; limit is 1048576/);
  // Feed the command through its filesystem boundary without creating 512 MiB on disk.
  const original = fs.readdirSync, read = fs.readFileSync, stat = fs.lstatSync;
  let mode = 'count';
  fs.readdirSync = (dir, opts) => dir === f.input ? Array.from({ length: mode === 'count' ? 20001 : 513 }, (_, i) => ({ name: `${i}.md`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })) : original(dir, opts);
  const megabyte = 'x'.repeat(limits.cardBytes);
  fs.readFileSync = (file, ...rest) => String(file).startsWith(f.input + path.sep) ? (mode === 'count' ? '' : megabyte) : read(file, ...rest);
  fs.lstatSync = (file, ...rest) => String(file).startsWith(f.input + path.sep) ? { size: mode === 'count' ? 0 : limits.cardBytes, isFile: () => true, isSymbolicLink: () => false } : stat(file, ...rest);
  try {
    assert.throws(() => f.run(), /card limit is 20000/); assert.equal(fs.existsSync(f.atlas), false);
    mode = 'total'; assert.throws(() => f.run(), /536870912 bytes/); assert.equal(fs.existsSync(f.atlas), false);
  } finally { fs.readdirSync = original; fs.readFileSync = read; fs.lstatSync = stat; }
});

test('Plan 5: collision additions and removals preserve manifest paths', () => {
  const f = fixture(); f.put('a b.md'); f.run();
  const before = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json'))).entries['a b.md'].path;
  f.put('a-b.md'); const report = f.run(); assert.ok(report.warnings.length);
  let manifest = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json')));
  assert.equal(manifest.entries['a b.md'].path, before); const second = manifest.entries['a-b.md'].path;
  fs.unlinkSync(path.join(f.input, 'a b.md')); f.run(); manifest = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json')));
  assert.equal(manifest.entries['a-b.md'].path, second); manifestMatches(f);
  const pair = toNotes([item('x y.md'), item('x-y.md')], { source, importedAt: time });
  assert.ok(pair.notes.every(n => /-[a-f0-9]{8}\.md$/.test(n.path))); assert.equal(pair.warnings.length, 2);
});

test('Plan 6: Atlas public export generates every title as its about line', () => {
  const result = checkSource(source, [{ path: 'one.md', text: '---\ntitle: Metadata Only\n---\nBody\n' }, { path: 'two.md', text: '# Heading Only\n' }]);
  const notes = toNotes(result.items, { source, importedAt: time }).notes;
  const atlas = buildAtlas(notes, { indexThreshold: 1 }); assert.deepEqual(atlas.conflicts, []);
  const index = atlas.writes.find(w => w.path === 'sources/recall/INDEX.md').text;
  // Atlas suppresses the about text when it exactly repeats the title.
  assert.ok(index.includes('- [Metadata Only](one.md)\n'), index);
  assert.ok(index.includes('- [Heading Only](two.md)\n'), index);
});

test('Plan 8: interruption after rename is completed on next run', () => {
  const f = fixture(); f.put('one.md'); assert.throws(() => f.run({ afterRename: () => { throw Error('Interrupted'); } }), /Interrupted/);
  f.run(); manifestMatches(f);
});

test('Plan 9: unsafe source keys fail in both APIs and case paths stay inside', () => {
  for (const key of ['../x', '/x', 'a/./b', '.hidden', 'a/../b', 'a\\b', 'a\u0000b']) {
    const bad = { id: 'invented', name: 'Invented', read: () => ({ items: [item(key)], skipped: [], warnings: [] }) };
    assert.throws(() => checkSource(bad, []), /Refusing key/); assert.throws(() => toNotes([item(key)], { source, importedAt: time }), /Refusing key/);
  }
  const notes = toNotes([item('A'), item('a')], { source, importedAt: time }).notes;
  assert.equal(new Set(notes.map(n => n.path.toLowerCase())).size, 2); assert.ok(notes.every(n => n.path.startsWith('sources/recall/')));
});

test('Plan 10 and Carried 1: README source interface uses distinct id and name', () => {
  const invented = { id: 'invented', name: 'Sample Library', read: files => ({ items: files.map(f => ({ ...item(f.path), body: f.text, extra: { shelf: 'later' } })), skipped: [], warnings: [] }) };
  const result = checkSource(invented, [{ path: 'one.md', text: 'Unchanged body without newline' }]);
  const note = toNotes(result.items, { source: invented, importedAt: time }).notes[0];
  assert.equal(note.path, 'sources/invented/one.md'); assert.match(note.text, /source: Sample Library/); assert.match(note.text, /invented:\n  shelf: later/); assert.ok(note.text.endsWith('Unchanged body without newline'));
});

test('Carried 2: fixed imported-at reaches every command note', () => {
  const f = fixture(); f.put('one.md'); f.put('nested/two.md'); f.run();
  for (const name of ['one.md', 'nested/two.md']) assert.ok(fs.readFileSync(path.join(f.dir, name), 'utf8').includes(`imported: ${time}\n`));
});

test('Carried 3: unsafe source id refuses both APIs and command without writes', () => {
  const f = fixture(); f.put('one.md'); const bad = { ...source, id: '../../private' };
  assert.throws(() => checkSource(bad, []), /source id/); assert.throws(() => toNotes([], { source: bad, importedAt: time }), /source id/);
  assert.throws(() => runImport([...f.argv, '--source', bad.id], { sources: [bad] }), /source id/); assert.equal(fs.existsSync(f.atlas), false);
});

test('Carried 4: Recall unknown fields and second-source extra survive disk import', () => {
  const f = fixture(); f.put('one.md', '---\ncustom: retained\n---\nBody'); f.run(); assert.match(fs.readFileSync(path.join(f.dir, 'one.md'), 'utf8'), /recall:\n  custom: retained/);
  const other = { id: 'other', name: 'Another Source', read: files => ({ items: files.map(f => ({ ...item(f.path), extra: { shelf: 'later' } })), skipped: [], warnings: [] }) };
  sources.push(other);
  try { runImport([...f.argv, '--source', 'other']); assert.match(fs.readFileSync(path.join(f.atlas, 'sources/other/one.md'), 'utf8'), /other:\n  shelf: later/); } finally { sources.pop(); }
});

test('Carried 6: registered second source is selected by command', () => {
  const f = fixture(); f.put('one.md'); const other = { ...source, id: 'other', name: 'Invented Other' }; sources.push(other);
  try { runImport([...f.argv, '--source', 'other']); assert.equal(fs.existsSync(path.join(f.atlas, 'sources/other/one.md')), true); assert.equal(fs.existsSync(f.dir), false); } finally { sources.pop(); }
});

test('Carried 8: symbolic links at every destination level refuse before writes', () => {
  for (const level of ['', 'sources', 'sources/recall', 'sources/recall/nested', 'sources/recall/nested/deeper', 'sources/recall/.import-manifest.json', 'sources/recall/nested/deeper/one.md']) {
    const f = fixture(); f.put('nested/deeper/one.md'); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const target = path.join(f.atlas, level); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(outside, target);
    assert.throws(() => f.run(), /non-folder/); assert.deepEqual(fs.readdirSync(outside), []);
    if (level && !level.startsWith('sources/recall/')) continue;
    assert.equal(fs.existsSync(path.join(f.dir, '.import.lock')), false);
  }
});

test('Carried 9: reserved INDEX case variants in nested folders use hash paths', () => {
  for (const key of ['INDEX.md', 'nested/index.md', 'nested/deeper/InDeX.md']) {
    const first = toNotes([item(key)], { source, importedAt: time });
    assert.ok(first.notes[0].path.endsWith(`-${sha(key).slice(0, 8)}.md`)); assert.equal(first.warnings.length, 1);
  }
});

test('Carried 10: injected hash8 collision creates distinct files and manifest paths', () => {
  const f = fixture(); f.put('a b.md'); f.put('a-b.md');
  f.run({ hashKey: key => '12345678' + (key.includes(' ') ? 'a' : 'b').repeat(56) });
  const entries = Object.values(JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json'))).entries);
  assert.equal(new Set(entries.map(e => e.path.toLowerCase())).size, 2);
  assert.ok(entries.some(e => /12345678[a-f]{8}\.md$/.test(e.path))); manifestMatches(f);
});

test('Carried 10: suffixes escalate to full hash and exhausted collisions refuse', () => {
  const keys = ['a b.md', 'a-b.md', 'a?b.md', 'a*b.md', 'a+b.md'];
  const hashKey = () => 'a'.repeat(64);
  const converted = toNotes(keys.slice(0, 3).map(item), { source, importedAt: time, hashKey });
  assert.ok(converted.notes.some(n => n.path.endsWith('-' + 'a'.repeat(64) + '.md')));
  assert.throws(() => toNotes(keys.map(item), { source, importedAt: time, hashKey }), /unique path/);
  const f = fixture(); for (const key of keys) f.put(key);
  assert.throws(() => f.run({ hashKey }), /unique path/);
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.md')), false);
});

test('Carried 11: umask 022 creates all nested directories 0700 without widening existing', () => {
  const f = fixture(); f.put('nested/deeper/one.md'); fs.mkdirSync(f.atlas, { mode: 0o700 });
  const old = process.umask(0o022); try { f.run(); } finally { process.umask(old); }
  for (const name of ['sources', 'sources/recall', 'sources/recall/nested', 'sources/recall/nested/deeper']) assert.equal(fs.statSync(path.join(f.atlas, name)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.dir, 'nested/deeper/one.md')).mode & 0o777, 0o600);
  fs.chmodSync(path.join(f.dir, 'nested'), 0o500); f.run(); assert.equal(fs.statSync(path.join(f.dir, 'nested')).mode & 0o777, 0o500); fs.chmodSync(path.join(f.dir, 'nested'), 0o700);
});

test('Carried 12: overlapping imports refuse one and leave manifest matching disk', () => {
  const f = fixture(); f.put('one.md'); let refused = 0;
  f.run({ beforeRename: () => { assert.throws(() => f.run(), /Another import is running/); refused++; } });
  assert.equal(refused, 1); manifestMatches(f);
});

test('Carried 12: dead same-host lock recovers pending import; foreign lock is kept', () => {
  const f = fixture(); f.put('one.md'); assert.throws(() => f.run({ afterRename: () => { throw Error('Interrupted'); } }));
  const lock = path.join(f.dir, '.import.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, host: os.hostname() }));
  assert.ok(f.run().messages.some(m => m.includes('cleared its lock'))); manifestMatches(f);
  const foreign = JSON.stringify({ pid: 2147483647, host: 'invented-other-host' }); fs.writeFileSync(lock, foreign);
  assert.throws(() => f.run(), /Another import is running/); assert.equal(fs.readFileSync(lock, 'utf8'), foreign);
});

test('Carried 13: whole lock publication and empty or malformed lock recovery', () => {
  const f = fixture(); f.put('one.md');
  f.run({ beforeRename: () => { const lock = JSON.parse(fs.readFileSync(path.join(f.dir, '.import.lock'))); assert.equal(lock.pid, process.pid); assert.equal(lock.host, os.hostname()); assert.equal(fs.readdirSync(f.dir).some(n => n.includes('.new-')), false); } });
  for (const content of ['', '{broken']) { fs.writeFileSync(path.join(f.dir, '.import.lock'), content); assert.ok(f.run().messages.some(m => m.includes('cleared its lock'))); manifestMatches(f); }
});

test('Carried 14: two overlapping recoverers have exactly one winner', () => {
  const f = fixture(); f.put('one.md'); fs.mkdirSync(f.dir, { recursive: true }); fs.writeFileSync(path.join(f.dir, '.import.lock'), JSON.stringify({ pid: 2147483647, host: os.hostname() }));
  let winners = 0, refused = 0;
  f.run({ afterReclaimLock: () => { assert.throws(() => f.run(), /Another command is recovering/); refused++; }, afterRename: () => winners++ });
  assert.equal(winners, 1); assert.equal(refused, 1); manifestMatches(f);
});

test('Carried 14: printed unlock command removes only a confirmed dead reclaim lock', () => {
  const f = fixture(); f.put('one.md'); fs.mkdirSync(f.dir, { recursive: true }); const reclaim = path.join(f.dir, '.import.lock.reclaim');
  fs.writeFileSync(reclaim, JSON.stringify({ pid: 2147483647, host: os.hostname() }));
  assert.throws(() => f.run(), error => { assert.ok(error.message.includes(`unlock "${reclaim}"`)); return true; }); assert.equal(fs.existsSync(reclaim), true);
  runImport(['unlock', reclaim]); assert.equal(fs.existsSync(reclaim), false); f.run(); manifestMatches(f);
  for (const info of [{ pid: process.pid, host: os.hostname() }, { pid: 2147483647, host: 'invented-foreign-host' }]) { fs.writeFileSync(reclaim, JSON.stringify(info)); assert.throws(() => runImport(['unlock', reclaim]), /cannot be confirmed gone/); assert.equal(fs.existsSync(reclaim), true); }
});
