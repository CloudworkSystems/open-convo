import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
import { checkSource, recallSource, toNotes, limits } from '../src/sources.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-second-p1-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  return { root, input, atlas, argv: ['--in', input, '--atlas', atlas, '--write', '--imported-at', '2026-11-05T12:00:00.000Z'] };
}

test('Second P1 1: oversized cards are stat-checked and skipped without reading content', () => {
  const f = fixture(), file = path.join(f.input, 'large.md'); fs.writeFileSync(file, 'invented');
  const stat = fs.lstatSync, read = fs.readFileSync; let reads = 0;
  fs.lstatSync = (target, ...rest) => { const result = stat(target, ...rest); if (target === file) Object.defineProperty(result, 'size', { value: limits.cardBytes + 1 }); return result; };
  fs.readFileSync = (target, ...rest) => { if (target === file) { reads++; throw Error('Oversized file content was read'); } return read(target, ...rest); };
  try {
    const report = runImport(f.argv);
    assert.equal(reads, 0); assert.equal(report.skipped[0].sourcePath, 'large.md');
    assert.equal(report.skipped[0].reason, 'card is 1048577 bytes; limit is 1048576'); assert.equal(fs.existsSync(f.atlas), false);
  } finally { fs.lstatSync = stat; fs.readFileSync = read; }
});

test('Second P1 1: export total is refused before reading any file content', () => {
  const f = fixture();
  const stat = fs.lstatSync, read = fs.readFileSync, list = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = (target, ...rest) => target === f.input ? Array.from({ length: 513 }, (_, i) => ({ name: `${i}.md`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })) : list(target, ...rest);
  fs.lstatSync = (target, ...rest) => String(target).startsWith(f.input + path.sep) ? { size: limits.cardBytes, isFile: () => true, isSymbolicLink: () => false } : stat(target, ...rest);
  fs.readFileSync = (target, ...rest) => { if (String(target).startsWith(f.input + path.sep)) { reads++; throw Error('Content read before total check'); } return read(target, ...rest); };
  try { assert.throws(() => runImport(f.argv), /Refusing export larger than 536870912 bytes/); assert.equal(reads, 0); assert.equal(fs.existsSync(f.atlas), false); }
  finally { fs.lstatSync = stat; fs.readFileSync = read; fs.readdirSync = list; }
});

test('Sweep: card count is refused before reading any file content', () => {
  const f = fixture();
  const stat = fs.lstatSync, read = fs.readFileSync, list = fs.readdirSync; let reads = 0;
  fs.readdirSync = (target, ...rest) => target === f.input ? Array.from({ length: limits.cards + 1 }, (_, i) => ({ name: `${i}.md`, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })) : list(target, ...rest);
  fs.lstatSync = (target, ...rest) => String(target).startsWith(f.input + path.sep) ? { size: 0, isFile: () => true, isSymbolicLink: () => false } : stat(target, ...rest);
  fs.readFileSync = (target, ...rest) => { if (String(target).startsWith(f.input + path.sep)) { reads++; throw Error('Content read before count check'); } return read(target, ...rest); };
  try { assert.throws(() => runImport(f.argv), /card limit is 20000/); assert.equal(reads, 0); assert.equal(fs.existsSync(f.atlas), false); }
  finally { fs.lstatSync = stat; fs.readFileSync = read; fs.readdirSync = list; }
});

test('Second P1 2: every source scalar uses string-preserving quotes', () => {
  for (const value of ['null', 'true', 'false', '001', '2026-01-02', 'yes', 'off', '-1', '.NaN', '-', '@text', 'key: value', 'text\nnext line']) {
    const source = { id: 'invented', name: value, read() {} };
    const item = { key: 'one.md', title: value, body: '', url: value, tags: [value], created: value, sourcePath: 'one.md', extra: { nested: { field: value }, list: [value] } };
    const note = toNotes([item], { source, importedAt: '2026-11-05T12:00:00.000Z' }).notes[0].text;
    for (const field of ['title', 'description', 'source', 'url', 'created']) {
      const expected = ['title', 'description'].includes(field) ? value.replace(/[\t\r\n\u2028\u2029]/g, ' ') : value;
      const encoded = new RegExp(`^${field}: (.+)$`, 'm').exec(note)?.[1];
      if (['title', 'description'].includes(field) && expected !== value) assert.equal(encoded, expected);
      else assert.equal(encoded, JSON.stringify(value), field + ': ' + value);
    }
    assert.ok(note.includes(`  - ${JSON.stringify(value)}\n`));
    assert.ok(note.includes(`    field: ${JSON.stringify(value)}\n`));
  }
});

test('Sweep: files that grow after stat are refused before allocation or content reads', () => {
  const f = fixture(), file = path.join(f.input, 'one.md'); fs.writeFileSync(file, '# Invented\n');
  const open = fs.openSync, read = fs.readSync;
  let reads = 0;
  fs.openSync = (target, ...rest) => { if (target === file) fs.appendFileSync(file, 'changed'); return open(target, ...rest); };
  fs.readSync = (...params) => { reads++; return read(...params); };
  try { assert.throws(() => runImport(f.argv), /changed during the import/); assert.equal(reads, 0); assert.equal(fs.existsSync(f.atlas), false); }
  finally { fs.openSync = open; fs.readSync = read; }
});

test('Sweep: Recall non-card files are listed without reading their content', () => {
  const f = fixture(), file = path.join(f.input, 'attachment.bin'); fs.writeFileSync(file, 'Invented attachment');
  const open = fs.openSync, read = fs.readFileSync;
  fs.openSync = (target, ...rest) => { assert.notEqual(target, file, 'non-card opened'); return open(target, ...rest); };
  fs.readFileSync = (target, ...rest) => { assert.notEqual(target, file, 'non-card read'); return read(target, ...rest); };
  try { const report = runImport(f.argv); assert.deepEqual(report.skipped, [{ sourcePath: 'attachment.bin', reason: 'not a Markdown card' }]); }
  finally { fs.openSync = open; fs.readFileSync = read; }
});

test('Sweep: source contract checks count and total before calling any reader', () => {
  const source = { id: 'invented', name: 'Invented', read() { throw Error('Reader called before file limits'); } };
  const files = Array.from({ length: limits.cards + 1 }, (_, i) => ({ path: `${i}.md`, get text() { throw Error('Content accessed before card count'); } }));
  assert.throws(() => checkSource(source, files), /card limit is 20000/);
  const text = 'x'.repeat(limits.cardBytes);
  assert.throws(() => checkSource(source, Array.from({ length: 513 }, (_, i) => ({ path: `${i}.md`, text }))), /Refusing export larger than 536870912 bytes/);
});

test('Sweep: tag count and length are checked before buffering a tag list', () => {
  const split = String.prototype.split;
  String.prototype.split = function(separator, ...rest) { if (separator === ',') throw Error('Tag list buffered before checking limits'); return split.call(this, separator, ...rest); };
  try {
    const source = recallSource();
    for (const tags of [Array(51).fill('tag').join(','), 'x'.repeat(101)]) assert.throws(() => checkSource(source, [{ path: 'one.md', text: `---\ntags: [${tags}]\n---\nBody` }]), /invalid tags/);
    assert.equal(checkSource(source, [{ path: 'one.md', text: `---\ntags: [${Array(50).fill('tag').join(',')}]\n---\nBody` }]).items[0].tags.length, 50);
  } finally { String.prototype.split = split; }
});

test('Sweep: quoted Recall tags are decoded once before text-preserving output', () => {
  const source = recallSource();
  const result = checkSource(source, [{ path: 'one.md', text: '---\ntitle: "001"\ntags: ["null", \'true\', "001"]\ncreated: "2026-01-02"\n---\nBody' }]);
  assert.deepEqual(result.items[0].tags, ['null', 'true', '001']);
  const text = toNotes(result.items, { source, importedAt: '2026-11-05T12:00:00.000Z' }).notes[0].text;
  assert.ok(text.includes('title: "001"\n')); assert.ok(text.includes('  - "null"\n')); assert.ok(text.includes('created: "2026-01-02"\n'));
});
