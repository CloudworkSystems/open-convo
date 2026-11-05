import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSource, recallSource, toNotes } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';

const time = '2026-11-05T12:00:00.000Z';
const card = () => ({ key: 'one.md', title: 'Invented', body: 'Body', url: null, created: null, tags: [], sourcePath: 'one.md' });
const files = [{ path: 'one.md', text: '# Invented\n' }];
const reader = result => ({ id: 'invented', name: 'Invented', read: () => result });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-third-p1-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  const dir = path.join(atlas, 'sources/recall'), manifest = path.join(dir, '.import-manifest.json');
  return { input, atlas, dir, manifest, argv: ['--in', input, '--atlas', atlas, '--write', '--imported-at', time] };
}

test('Third P1 1: validates every skipped entry and warning', () => {
  for (const skipped of [[{}], [null], [{ sourcePath: 'one.md' }], [{ sourcePath: 42, reason: 'Invented reason' }], [{ sourcePath: 'one.md', reason: 42 }], [{ sourcePath: 'one.md', reason: '' }]]) {
    assert.throws(() => checkSource(reader({ items: [], skipped, warnings: [] }), files), /skipped/i);
  }
  for (const warnings of [[42], [null], [''], ['A warning without a file name']]) {
    assert.throws(() => checkSource(reader({ items: [], skipped: [], warnings }), files), /warning/i);
  }
  assert.doesNotThrow(() => checkSource(reader({ items: [], skipped: [{ sourcePath: 'one.md', reason: 'Not supported' }], warnings: ['one.md: kept original text.'] }), files));
});

test('Third P1 1: validates required item fields in checkSource and toNotes', () => {
  for (const field of ['key', 'title', 'body', 'url', 'tags', 'created', 'sourcePath']) {
    const bad = card(); delete bad[field];
    assert.throws(() => checkSource(reader({ items: [bad], skipped: [], warnings: [] }), files), undefined, field);
    assert.throws(() => toNotes([bad], { source: reader({}), importedAt: time }), undefined, field);
  }
  for (const patch of [{ key: 42 }, { sourcePath: 42 }, { sourcePath: '' }, { title: ' ' }, { title: 'x'.repeat(201) }, { title: 42 }, { body: 42 }, { tags: null }, { tags: [''] }, { tags: [42] }, { tags: Array(51).fill('tag') }, { tags: ['x'.repeat(101)] }, { tags: Array(1) }, { url: 42 }, { created: false }]) {
    const bad = { ...card(), ...patch };
    assert.throws(() => checkSource(reader({ items: [bad], skipped: [], warnings: [] }), files));
    assert.throws(() => toNotes([bad], { source: reader({}), importedAt: time }));
  }
});

test('Sweep: source ids input files and extra fields reject invalid contract types', () => {
  const source = reader({ items: [], skipped: [], warnings: [] });
  assert.throws(() => checkSource({ ...source, id: { toString: () => 'invented' } }, []), /source id/);
  for (const file of [{ path: 42, text: '' }, { path: 'one.md', text: Buffer.from('invented') }, { path: '../one.md', text: '' }]) assert.throws(() => checkSource(source, [file]), /file/i);
  const circular = {}; circular.self = circular;
  for (const extra of [new Date('2026-01-01T00:00:00Z'), { fn() {} }, { missing: undefined }, { bad: NaN }, circular]) {
    const bad = { ...card(), extra };
    assert.throws(() => checkSource(reader({ items: [bad], skipped: [], warnings: [] }), files), /extra|plain|circular/i);
    assert.throws(() => toNotes([bad], { source, importedAt: time }), /extra|plain|circular/i);
  }
});

test('Third P1 2: removing the last card reports the retained note', () => {
  const f = fixture(); const input = path.join(f.input, 'one.md'); fs.writeFileSync(input, files[0].text); runImport(f.argv);
  const note = fs.readFileSync(path.join(f.dir, 'one.md'), 'utf8'); fs.unlinkSync(input);
  const report = runImport(f.argv);
  assert.ok(report.messages.some(m => m.includes('sources/recall/one.md: no longer in Recall')));
  assert.equal(fs.readFileSync(path.join(f.dir, 'one.md'), 'utf8'), note);
});

test('Third P1 2: an empty retry reconciles pending ownership after rename', () => {
  const f = fixture(); const input = path.join(f.input, 'one.md'); fs.writeFileSync(input, files[0].text);
  assert.throws(() => runImport(f.argv, { afterRename() { throw Error('Interrupted'); } }), /Interrupted/);
  const pending = JSON.parse(fs.readFileSync(f.manifest)).pending['one.md']; fs.unlinkSync(input);
  const report = runImport(f.argv); const manifest = JSON.parse(fs.readFileSync(f.manifest));
  assert.deepEqual(manifest.pending, {}); assert.deepEqual(manifest.entries['one.md'], pending);
  assert.ok(report.messages.some(m => m.includes('no longer in Recall')));
  assert.equal(fs.existsSync(path.join(f.dir, 'one.md')), true);
});

test('Sweep: removed pending cards reconcile when other cards remain', () => {
  const f = fixture(); const input = path.join(f.input, 'one.md'); fs.writeFileSync(input, files[0].text);
  assert.throws(() => runImport(f.argv, { afterRename() { throw Error('Interrupted'); } }));
  fs.unlinkSync(input); fs.writeFileSync(path.join(f.input, 'two.md'), '# Other invented card\n');
  const report = runImport(f.argv); const manifest = JSON.parse(fs.readFileSync(f.manifest));
  assert.deepEqual(manifest.pending, {}); assert.ok(manifest.entries['one.md']); assert.ok(manifest.entries['two.md']);
  assert.ok(report.messages.some(m => m.includes('one.md: no longer in Recall')));
});

test('Sweep: empty first runs and dry runs create nothing or change no manifest', () => {
  const f = fixture(); runImport(f.argv); assert.equal(fs.existsSync(f.atlas), false);
  fs.writeFileSync(path.join(f.input, 'one.md'), files[0].text); runImport(f.argv); fs.unlinkSync(path.join(f.input, 'one.md'));
  const before = fs.readFileSync(f.manifest, 'utf8'); runImport(f.argv.filter(arg => arg !== '--write'));
  assert.equal(fs.readFileSync(f.manifest, 'utf8'), before);
});

test('Sweep: all-skipped imports still report removed cards and preserve edited pending notes', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.input, 'one.md'), files[0].text);
  assert.throws(() => runImport(f.argv, { afterRename() { throw Error('Interrupted'); } }));
  fs.appendFileSync(path.join(f.dir, 'one.md'), 'Owner edit\n'); fs.unlinkSync(path.join(f.input, 'one.md'));
  fs.writeFileSync(path.join(f.input, 'attachment.txt'), 'Invented');
  const report = runImport(f.argv);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)).pending, {});
  assert.ok(report.messages.some(m => m.includes('kept, edited since the last import')));
  assert.ok(report.messages.some(m => m.includes('no longer in Recall')));
  assert.match(fs.readFileSync(path.join(f.dir, 'one.md'), 'utf8'), /Owner edit/);
});

test('Sweep: empty recovery before note rename clears pending without creating a note', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.input, 'one.md'), files[0].text);
  let temporary;
  assert.throws(() => runImport(f.argv, { beforeRename({ temp }) { temporary = temp; throw Error('Interrupted before rename'); } }), /Interrupted before rename/);
  fs.unlinkSync(path.join(f.input, 'one.md'));
  const report = runImport(f.argv);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)).pending, {});
  assert.equal(fs.existsSync(path.join(f.dir, 'one.md')), false);
  assert.ok(!report.messages.some(m => /kept|no longer/.test(m)));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)).entries, {});
  // The interrupted temporary note is never mistaken for a completed note.
  assert.equal(fs.existsSync(temporary), false);
});
