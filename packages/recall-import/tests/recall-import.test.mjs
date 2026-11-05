import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAtlas } from '../../atlas-index/src/index.mjs';
import { checkSource, limits, recallSource, toNotes } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';

const fixed = '2026-11-05T12:00:00.000Z';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recall-import-test-'));
const write = (root, name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const args = (input, atlas, more = []) => ['--in', input, '--atlas', atlas, '--imported-at', fixed, ...more];

test('Recall reads invented cards and writes deterministic Atlas notes', () => {
  const files = [
    { path: 'front.md', text: '---\ntitle: Front Title\nurl: https://example.invalid/card\ntags: [one, two]\ncreated: 2026-01-02\nunknown: kept\n---\nBody.\n' },
    { path: 'nested/heading.md', text: '# Heading Title\n\nText ![image](https://example.invalid/x.png).\n' },
    { path: 'filename.md', text: 'Plain body.\n' },
    { path: 'asset.bin', text: 'invented' }
  ];
  const result = checkSource(recallSource(), files);
  assert.deepEqual(result.items.map(item => item.title), ['Front Title', 'Heading Title', 'filename']);
  assert.deepEqual(result.items[0].tags, ['one', 'two']);
  assert.deepEqual(result.items[0].extra, { unknown: 'kept' });
  assert.match(result.items[1].body, /Images in this card were not imported/);
  assert.deepEqual(result.skipped, [{ sourcePath: 'asset.bin', reason: 'not a Markdown card' }]);
  const converted = toNotes(result.items, { source: recallSource(), importedAt: fixed });
  assert.equal(converted.notes[0].path, 'sources/recall/front.md');
  assert.match(converted.notes[0].text, /description: Front Title/);
  assert.match(converted.notes[0].text, /recall:\n  unknown: kept/);
  const atlas = buildAtlas(converted.notes.map(({ path: notePath, text }) => ({ path: notePath, text })), { indexThreshold: 1 });
  assert.match(JSON.stringify(atlas), /Front Title/);
});

test('unparseable front matter stays in the body and warns', () => {
  const result = recallSource().read([{ path: 'odd.md', text: '---\ntitle: Fine\nnot simple\n---\nBody\n' }]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.items[0].body, /^---/);
});

test('source contract rejects unsafe keys, duplicate keys, unstable output and unsafe ids', () => {
  const base = key => ({ id: 'invented', name: 'Invented Source', read: () => ({ items: [{ key, title: 'T', body: '', url: null, tags: [], created: null, sourcePath: 'x' }], skipped: [], warnings: [] }) });
  for (const key of ['../x', '/x', 'a/./b', '.hidden', 'a\\b']) assert.throws(() => checkSource(base(key), []), /Refusing key/);
  assert.throws(() => checkSource({ ...base('x'), id: '../../private' }, []), /source id/);
  let turn = 0;
  assert.throws(() => checkSource({ ...base('x'), read: () => ({ items: [{ key: String(++turn), title: 'T', body: '', url: null, tags: [], created: null, sourcePath: 'x' }], skipped: [], warnings: [] }) }, []), /different results/);
});

test('second source keeps its different id, name and extra fields', () => {
  const source = { id: 'bookmarks', name: 'Invented Reading List', read: () => ({ items: [], skipped: [], warnings: [] }) };
  const item = { key: 'one.md', title: 'One', body: 'Body', url: null, tags: [], created: null, sourcePath: 'one.md', extra: { shelf: 'later' } };
  const { notes } = toNotes([item], { source, importedAt: fixed });
  assert.equal(notes[0].path, 'sources/bookmarks/one.md');
  assert.match(notes[0].text, /source: Invented Reading List/);
  assert.match(notes[0].text, /bookmarks:\n  shelf: later/);
  assert.doesNotMatch(notes[0].text, /source: Recall/);
});

test('collisions, case collisions and reserved index names get stable unique paths', () => {
  const source = recallSource();
  const item = key => ({ key, title: key, body: '', url: null, tags: [], created: null, sourcePath: key });
  const first = toNotes([item('A B.md'), item('A-B.md'), item('nested/InDeX.md')], { source, importedAt: fixed, hashKey: () => 'a'.repeat(64) });
  assert.equal(new Set(first.notes.map(n => n.path.toLowerCase())).size, 3);
  assert.ok(first.notes.every(n => n.path !== 'sources/recall/nested/InDeX.md'));
  assert.ok(first.warnings.length >= 3);
  const casePair = toNotes([item('A.md'), item('a.md')], { source, importedAt: fixed });
  assert.equal(new Set(casePair.notes.map(n => n.path.toLowerCase())).size, 2);
});

test('command dry run and fixed imported time use an invented registered source', () => {
  const root = temp(), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  write(input, 'one.md', 'Invented body');
  const source = { id: 'invented', name: 'Different Name', read: files => ({ items: files.map(file => ({ key: file.path, title: 'Made Up', body: file.text, url: null, tags: [], created: null, sourcePath: file.path, extra: { flavor: 'plain' } })), skipped: [], warnings: [] }) };
  const report = runImport(args(input, atlas, ['--source', 'invented', '--write']), { sources: [source] });
  assert.equal(report.notes, 1);
  const text = fs.readFileSync(path.join(atlas, 'sources/invented/one.md'), 'utf8');
  assert.match(text, new RegExp(`imported: ${fixed.replaceAll('.', '\\.')}`));
  assert.match(text, /source: Different Name/);
});

test('Plan 7 and Carried 7: re-import leaves unchanged, replaces changed, protects edits and keeps removed and unrelated files', () => {
  const root = temp(), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  write(input, 'one.md', '# One\n\nFirst\n'); write(input, 'gone.md', '# Gone\n');
  runImport(args(input, atlas, ['--write']));
  const one = path.join(atlas, 'sources/recall/one.md'), gone = path.join(atlas, 'sources/recall/gone.md');
  const before = fs.statSync(one).mtimeMs;
  const second = runImport(['--in', input, '--atlas', atlas, '--imported-at', '2030-01-01T00:00:00.000Z', '--write']);
  assert.equal(fs.statSync(one).mtimeMs, before);
  assert.ok(second.messages.some(m => m.includes('unchanged')));
  write(input, 'one.md', '# One\n\nChanged\n'); fs.rmSync(path.join(input, 'gone.md'));
  const unrelated = write(path.join(atlas, 'sources/recall'), 'unrelated.md', 'owner file');
  const third = runImport(args(input, atlas, ['--write']));
  assert.ok(third.messages.some(message => message.includes('no longer in Recall')));
  assert.match(fs.readFileSync(one, 'utf8'), /Changed/); assert.ok(fs.existsSync(gone)); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'owner file');
  fs.writeFileSync(one, fs.readFileSync(one, 'utf8').replace(`imported: ${fixed}`, 'imported: owner-edit'));
  write(input, 'one.md', '# One\n\nChanged again\n');
  const fourth = runImport(args(input, atlas, ['--write']));
  assert.match(fs.readFileSync(one, 'utf8'), /owner-edit/); assert.ok(fourth.messages.some(m => m.includes('kept, edited')));
});

test('Plan 12: last check protects a note edited just before rename and removes temporary file', () => {
  const root = temp(), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input); write(input, 'one.md', '# One\n');
  runImport(args(input, atlas, ['--write'])); write(input, 'one.md', '# One\nChanged\n');
  const report = runImport(args(input, atlas, ['--write']), { beforeRename: ({ destination }) => fs.appendFileSync(destination, '\nOwner edit\n') });
  assert.match(fs.readFileSync(path.join(atlas, 'sources/recall/one.md'), 'utf8'), /Owner edit/);
  assert.ok(report.messages.some(m => m.includes('kept, edited')));
  assert.equal(fs.readdirSync(path.join(atlas, 'sources/recall')).some(name => name.includes('.tmp-')), false);
});

test('Carried 5: interrupted rename is owned on retry even when the card changes', () => {
  const root = temp(), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input); write(input, 'one.md', '# One\nFirst\n');
  assert.throws(() => runImport(args(input, atlas, ['--write']), { afterRename: () => { throw new Error('invented interruption'); } }), /interruption/);
  write(input, 'one.md', '# One\nSecond\n');
  const report = runImport(args(input, atlas, ['--write']));
  assert.match(fs.readFileSync(path.join(atlas, 'sources/recall/one.md'), 'utf8'), /Second/);
  assert.equal(report.messages.some(m => m.includes('kept, edited')), false);
});

test('zip, empty folder and export symlink are handled without following links', () => {
  const root = temp(), atlas = path.join(root, 'atlas'), zip = write(root, 'cards.zip', 'invented');
  assert.throws(() => runImport(args(zip, atlas)), /Unzip the export first/);
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
  assert.match(runImport(args(empty, atlas)).messages[0], /no Recall cards/);
  const outside = write(root, 'outside.md', '# Outside'); fs.symlinkSync(outside, path.join(empty, 'link.md'));
  const report = runImport(args(empty, atlas)); assert.equal(report.skipped[0].reason, 'symbolic links are not read');
});

test('limits report their messages', () => {
  const source = recallSource();
  const big = 'x'.repeat(limits.cardBytes + 1);
  assert.match(source.read([{ path: 'big.md', text: big }]).skipped[0].reason, /limit/);
  const tooMany = Array.from({ length: limits.cards + 1 }, (_, i) => ({ path: `${i}.md`, text: '' }));
  assert.throws(() => source.read(tooMany), /card limit/);
});

test('writes private modes, refuses destination symlinks, and recovers stale or empty locks', () => {
  const root = temp(), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input); write(input, 'nested/one.md', '# One');
  const old = process.umask(0o022); try { runImport(args(input, atlas, ['--write'])); } finally { process.umask(old); }
  for (const dir of [path.join(atlas, 'sources'), path.join(atlas, 'sources/recall'), path.join(atlas, 'sources/recall/nested')]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(atlas, 'sources/recall/nested/one.md')).mode & 0o777, 0o600);
  const lock = path.join(atlas, 'sources/recall/.import.lock'); fs.writeFileSync(lock, '');
  assert.ok(runImport(args(input, atlas, ['--write'])).messages.some(m => m.includes('cleared its lock')));
  const root2 = temp(), input2 = path.join(root2, 'input'), atlas2 = path.join(root2, 'atlas'), outside = path.join(root2, 'outside'); fs.mkdirSync(input2); fs.mkdirSync(atlas2); fs.mkdirSync(outside); write(input2, 'one.md', '# One'); fs.mkdirSync(path.join(atlas2, 'sources')); fs.symlinkSync(outside, path.join(atlas2, 'sources/recall'));
  assert.throws(() => runImport(args(input2, atlas2, ['--write'])), /non-folder/);
});

test('active and recovery locks refuse a second writer', () => {
  const root = temp(), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input); write(input, 'one.md', '# One');
  fs.mkdirSync(path.join(atlas, 'sources/recall'), { recursive: true });
  const lock = path.join(atlas, 'sources/recall/.import.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  assert.throws(() => runImport(args(input, atlas, ['--write'])), /Another import is running/);
  fs.rmSync(lock); fs.writeFileSync(`${lock}.reclaim`, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  assert.throws(() => runImport(args(input, atlas, ['--write'])), /Another command is recovering/);
});

test('Plan 11: library source has no file system, network, child process or clock access', () => {
  const text = fs.readFileSync(new URL('../src/sources.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /node:(?:fs|http|https|net|tls|child_process)/);
  assert.doesNotMatch(text, /Date\s*\.|new Date/);
});
