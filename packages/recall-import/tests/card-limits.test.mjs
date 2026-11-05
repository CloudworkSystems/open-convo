import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSource, recallSource, limits, toNotes } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';
const good = { path: 'good.md', text: '# Good invented card\n' };
const read = file => checkSource(recallSource(), [file, good]);

test('Card limit P1: 252-character filename gets a Unicode-safe title and imports its neighbor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-title-limit-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  const key = 'a'.repeat(252) + '.md'; fs.writeFileSync(path.join(input, key), 'Plain invented body\n'); fs.writeFileSync(path.join(input, good.path), good.text);
  const result = read({ path: key, text: 'Plain invented body\n' });
  assert.equal(result.items.find(i => i.key === key).title, 'a'.repeat(200)); assert.ok(result.warnings.some(w => w.includes(key) && w.includes('200')));
  const report = runImport(['--in', input, '--atlas', atlas, '--write', '--imported-at', '2026-11-05T12:00:00.000Z']); assert.equal(report.notes, 2);
});

test('Card limit P1: long multibyte filename is shortened without splitting a character', () => {
  const key = 'a'.repeat(191) + '😀'.repeat(15) + '.md'; assert.ok(Buffer.byteLength(key) <= 255);
  const result = read({ path: key, text: 'Plain invented body' });
  assert.equal(result.items[0].title, 'a'.repeat(191) + '😀'.repeat(4)); assert.equal(result.items.length, 2); assert.ok(result.warnings[0].includes(key));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-unicode-title-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, key), 'Plain invented body'); fs.writeFileSync(path.join(input, good.path), good.text);
  assert.equal(runImport(['--in', input, '--atlas', atlas, '--write', '--imported-at', '2026-11-05T12:00:00.000Z']).notes, 2);
});

test('Card limit sweep: oversized heading title is shortened while original body stays exact', () => {
  const body = '# ' + '😀'.repeat(101) + '\n'; const result = read({ path: 'heading.md', text: body });
  assert.equal(result.items[0].title, '😀'.repeat(100)); assert.equal(result.items[0].body, body); assert.equal(result.items.length, 2); assert.match(result.warnings[0], /heading.md/);
});

for (const [name, metadata] of [
  ['explicit title length', 'title: ' + 'x'.repeat(201)],
  ['explicit blank title', 'title: "   "'],
  ['flow tag count', 'tags: [' + Array(51).fill('tag').join(',') + ']'],
  ['block tag count', 'tags:\n' + Array(51).fill('  - tag').join('\n')],
  ['flow tag length', 'tags: [' + 'x'.repeat(101) + ']'],
  ['block tag length', 'tags:\n  - ' + 'x'.repeat(101)],
  ['blank tag', 'tags: ["   "]']
]) test(`Card limit sweep: ${name} skips only its card`, () => {
  const result = read({ path: 'odd.md', text: `---\n${metadata}\n---\nInvented body\n` });
  assert.deepEqual(result.items.map(i => i.key), ['good.md']); assert.equal(result.skipped[0].sourcePath, 'odd.md'); assert.match(result.skipped[0].reason, /title|tags/);
});

test('Card limit sweep: 1 MiB input-card limit skips only its card', () => {
  const result = read({ path: 'big.md', text: 'x'.repeat(limits.cardBytes + 1) }); assert.deepEqual(result.items.map(i => i.key), ['good.md']); assert.match(result.skipped[0].reason, /1048577 bytes/);
});

test('Card limit sweep: URL and flat extra data have no separate length cap within card size', () => {
  const url = 'https://example.invalid/' + 'x'.repeat(10000), value = 'x'.repeat(20000);
  const result = read({ path: 'large-fields.md', text: `---\nurl: ${url}\ncustom: ${value}\n---\nInvented body\n` });
  assert.equal(result.items[0].url, url); assert.equal(result.items[0].extra.custom, value); assert.equal(result.items.length, 2);
});

test('Card limit sweep: unsupported nested front matter stays as body rather than aborting', () => {
  const text = '---\ncustom:\n  nested:\n    value: invented\n---\nBody\n'; const result = read({ path: 'nested.md', text });
  assert.equal(result.items[0].body, text); assert.equal(result.items.length, 2); assert.match(result.warnings[0], /nested.md/);
});

test('Card limit sweep: buggy source authors still fail strict item validation', () => {
  const base = { key: 'one.md', sourcePath: 'one.md', title: 'Invented', body: '', url: null, created: null, tags: [] };
  for (const patch of [{ title: 'x'.repeat(201) }, { tags: Array(51).fill('tag') }, { tags: ['x'.repeat(101)] }, { url: 42 }, { body: null }, { extra: { invalid: undefined } }, { key: '../x' }]) {
    const bad = { ...base, ...patch }; const source = { id: 'invented', name: 'Invented', read: () => ({ items: [bad], skipped: [], warnings: [] }) };
    assert.throws(() => checkSource(source, [])); assert.throws(() => toNotes([bad], { source, importedAt: '2026-11-05T12:00:00.000Z' }));
  }
});

test('Card limit sweep: derived titles keep combining characters together and replace blank names', () => {
  const result = read({ path: 'grapheme.md', text: '# ' + 'a'.repeat(199) + 'e\u0301\n' });
  assert.equal(result.items[0].title, 'a'.repeat(199)); assert.match(result.warnings[0], /grapheme.md/);
  const blank = read({ path: '   .md', text: 'Plain body' }); assert.equal(blank.items[0].title, 'Untitled card'); assert.match(blank.warnings[0], /no usable text/); assert.equal(blank.items.length, 2);
});

for (const field of ['url', 'custom']) test(`Card limit sweep: oversized ${field} data hits only the input-card limit`, () => {
  const result = read({ path: 'oversized.md', text: `---\n${field}: ` + 'x'.repeat(limits.cardBytes) + '\n---\nBody' });
  assert.deepEqual(result.items.map(item => item.key), ['good.md']); assert.match(result.skipped[0].reason, /bytes; limit is 1048576/);
});
