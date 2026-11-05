import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
import { recallSource, checkSource, toNotes } from '../src/sources.mjs';
const fixed = '2026-11-05T12:00:00.000Z';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-options-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input); fs.mkdirSync(atlas); fs.writeFileSync(path.join(input, 'one.md'), '# Invented\n'); fs.writeFileSync(path.join(atlas, 'owner.txt'), 'Keep me');
  return { root, input, atlas, args: ['--in', input, '--atlas', atlas, '--write', '--imported-at', fixed] };
}
function refusal(f, argv, label, options) {
  const read = fs.readFileSync, open = fs.openSync; let reads = 0;
  fs.readFileSync = (...args) => { reads++; return read(...args); };
  fs.openSync = (...args) => { reads++; return open(...args); };
  try { assert.throws(() => runImport(argv, options), error => { assert.ok(error.message.includes(label), error.message); return true; }); }
  finally { fs.readFileSync = read; fs.openSync = open; }
  assert.equal(reads, 0, 'Invalid options must fail before opening or reading files');
  assert.deepEqual(fs.readdirSync(f.atlas), ['owner.txt']); assert.equal(fs.readFileSync(path.join(f.atlas, 'owner.txt'), 'utf8'), 'Keep me');
}
const cases = [
  ['--imported-at', a => [...a.slice(0, -1), 'not-a-date']],
  ['--imported-at', a => [...a.slice(0, -1), '2026-02-30T12:00:00Z']],
  ['--imported-at', a => [...a.slice(0, -1), '2026-01-01T25:00:00Z']],
  ['--imported-at', a => [...a.slice(0, -1), '2026-01-01T12:60:00Z']],
  ['--imported-at', a => [...a.slice(0, -1), '2026-01-01T12:00:61Z']],
  ['--imported-at', a => [...a.slice(0, -1), '2026-01-01T12:00:00']],
  ['--imported-at', a => [...a.slice(0, -1), '2026-01-01T12:00:00+24:00']],
  ['--in', a => [...a, '--in', path.join(path.dirname(a[1]), 'alternate-input')]],
  ['--atlas', a => [...a, '--atlas', path.join(path.dirname(a[3]), 'alternate-atlas')]],
  ['--source', a => [...a, '--source', 'recall', '--source', 'recall']],
  ['--write', a => [...a, '--write']],
  ['--json', a => [...a, '--json', '--json']],
  ['--imported-at', a => [...a, '--imported-at', fixed]],
  ['--in', a => ['--in', '--atlas', a[3]]],
  ['--atlas', a => ['--in', a[1], '--atlas']],
  ['--source', a => [...a, '--source']],
  ['--imported-at', a => [...a.slice(0, -1)]],
  ['--in', a => ['--in', '', ...a.slice(2)]],
  ['--atlas', a => [...a.slice(0, 3), '', ...a.slice(4)]],
  ['--in', a => ['--in', 'bad\0path', ...a.slice(2)]],
  ['--atlas', a => [...a.slice(0, 3), 'bad\0path', ...a.slice(4)]],
  ['--write', a => [...a, 'false']],
  ['--json', a => [...a, '--json', 'false']],
  ['--dry-run', a => [...a, '--dry-run']],
  ['--limits', a => [...a, '--limits', '1']],
  ['unlock', () => ['unlock', '/tmp/../.import.lock.reclaim']]
];
test('CLI input table: refuses invalid missing repeated and unknown flags before content access', () => {
  for (const [label, argv] of cases) { const f = fixture(); refusal(f, argv(f.args), label); }
});

for (const [label, options] of [
  ['limits', { limits: { cards: 1 } }], ['write', { write: true }], ['dryRun', { dryRun: true }], ['sources', { sources: 'recall' }],
  ['beforeRename', { beforeRename: true }], ['afterRename', { afterRename: 'bad' }], ['afterReclaimLock', { afterReclaimLock: 42 }], ['hashKey', { hashKey: 42 }]
]) test(`Option table: rejects ${label} before filesystem content access`, () => { const f = fixture(); refusal(f, f.args, label, options); });

test('Library boundary: importedAt and source ids are validated before conversion', () => {
  for (const importedAt of ['not-a-date', '2026-02-30T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:00:00', '2026-01-01T00:00:00.1234Z']) assert.throws(() => toNotes([], { source: recallSource(), importedAt }), /importedAt/);
  for (const id of ['recall\n', '../../private', '', 'a'.repeat(65), 42]) {
    const source = { ...recallSource(), id };
    assert.throws(() => checkSource(source, []), /source id/); assert.throws(() => toNotes([], { source, importedAt: fixed }), /source id/);
  }
});
test('Library boundary: toNotes rejects unknown and malformed options', () => {
  for (const options of [{ limits: {} }, { manifest: [] }, { hashKey: 42 }]) assert.throws(() => toNotes([], { source: recallSource(), importedAt: fixed, ...options }), /limits|manifest|hashKey/);
});
test('Timestamp normalization: CLI and toNotes store UTC with three fractional digits', () => {
  const source = recallSource(), importedAt = '2026-11-05T14:00:00+02:00';
  const item = { key: 'one.md', title: 'Invented', body: '', url: null, tags: [], created: null, sourcePath: 'one.md' };
  assert.ok(toNotes([item], { source, importedAt }).notes[0].text.includes(`imported: ${fixed}\n`));
  const f = fixture(); runImport([...f.args.slice(0, -1), importedAt]); assert.ok(fs.readFileSync(path.join(f.atlas, 'sources/recall/one.md'), 'utf8').includes(`imported: ${fixed}\n`));
});

test('Path preflight: --atlas rejects a file before reading export content', () => {
  const f = fixture(); const file = path.join(f.root, 'not-a-folder'); fs.writeFileSync(file, 'Invented');
  refusal(f, [...f.args.slice(0, 3), file, ...f.args.slice(4)], '--atlas');
});
test('Path preflight: --atlas refuses overlap with --in before reading export content', () => {
  const f = fixture(); refusal(f, [...f.args.slice(0, 3), f.input, ...f.args.slice(4)], '--atlas');
});
test('Timestamp calendar table: leap days and offsets normalize while invalid ranges refuse', () => {
  const source = recallSource();
  for (const importedAt of ['2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-01T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01T00:00:00+02:60']) assert.throws(() => toNotes([], { source, importedAt }), /importedAt/);
  const item = { key: 'one.md', title: 'Invented', body: '', url: null, tags: [], created: null, sourcePath: 'one.md' };
  assert.match(toNotes([item], { source, importedAt: '2024-02-29T01:30:00.5+01:30' }).notes[0].text, /imported: 2024-02-29T00:00:00.500Z/);
});
