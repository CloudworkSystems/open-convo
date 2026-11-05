import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkSource, recallSource, toNotes } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';

const importedAt = '2026-11-05T12:00:00.000Z';
const source = recallSource();
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-p1-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas');
  fs.mkdirSync(input);
  return { root, input, atlas, argv: ['--in', input, '--atlas', atlas, '--write', '--imported-at', importedAt] };
};

test('P1 1: non-Markdown files do not consume the card count', () => {
  const files = Array.from({ length: 20000 }, (_, i) => ({ path: `asset-${i}.txt`, text: '' }));
  files.push({ path: 'one.MD', text: '# Invented card\n' });
  const result = checkSource(source, files);
  assert.equal(result.items.length, 1);
  assert.equal(result.skipped.length, 20000);
  assert.ok(result.skipped.every(entry => entry.reason === 'not a Markdown card'));
});

test('P1 2: printed unlock arguments accept only a confirmed dead reclaim owner', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.input, 'one.md'), '# Invented\n');
  const dir = path.join(f.atlas, 'sources/recall'); fs.mkdirSync(dir, { recursive: true });
  const reclaim = path.join(dir, '.import.lock.reclaim');
  fs.writeFileSync(reclaim, JSON.stringify({ pid: 2147483647, host: os.hostname() }));
  let message;
  assert.throws(() => runImport(f.argv), error => { message = error.message; return /Another command is recovering/.test(message); });
  const match = /node "[^"]+" (unlock) "([^"]+)"/.exec(message);
  assert.ok(match, message);
  runImport([match[1], match[2]]);
  assert.equal(fs.existsSync(reclaim), false);
  for (const info of [{ pid: process.pid, host: os.hostname() }, { pid: 2147483647, host: 'invented-other-host' }, { pid: 0, host: os.hostname() }]) {
    fs.writeFileSync(reclaim, JSON.stringify(info));
    assert.throws(() => runImport(['unlock', reclaim]));
    assert.equal(fs.existsSync(reclaim), true);
  }
  fs.writeFileSync(reclaim, '{invalid');
  assert.throws(() => runImport(['unlock', reclaim]));
  assert.equal(fs.existsSync(reclaim), true);
});

test('P1 3: removed card manifest path makes a new colliding card use hash suffix', () => {
  const f = fixture(); const old = path.join(f.input, 'a b.md');
  fs.writeFileSync(old, '# Old invented card\n'); runImport(f.argv);
  const dir = path.join(f.atlas, 'sources/recall');
  const retained = fs.readFileSync(path.join(dir, 'a-b.md'), 'utf8');
  fs.unlinkSync(old); fs.writeFileSync(path.join(f.input, 'a-b.md'), '# New invented card\n');
  const report = runImport(f.argv);
  const suffix = createHash('sha256').update('a-b.md').digest('hex').slice(0, 8);
  assert.match(fs.readFileSync(path.join(dir, `a-b-${suffix}.md`), 'utf8'), /New invented card/);
  assert.equal(fs.readFileSync(path.join(dir, 'a-b.md'), 'utf8'), retained);
  assert.ok(report.warnings.some(warning => warning.includes(`a-b-${suffix}.md`)));
  assert.ok(report.messages.some(message => message.includes('no longer in Recall')));
});

test('P1 4: determinism comparison avoids cloning and whole-export serialization', () => {
  const clone = globalThis.structuredClone, stringify = JSON.stringify;
  const body = 'invented text '.repeat(2048);
  const files = [{ path: 'one.md', text: body }];
  globalThis.structuredClone = () => { throw Error('Full export cloning forbidden'); };
  JSON.stringify = value => {
    if (value && typeof value === 'object' || typeof value === 'string' && value.length > 4096) throw Error('Whole export serialization forbidden');
    return stringify(value);
  };
  try {
    const result = checkSource(source, files);
    assert.equal(result.items[0].body, body);
    let call = 0;
    const unstable = { ...source, read: input => { const result = source.read(input); result.items[0].body += String(++call); return result; } };
    assert.throws(() => checkSource(unstable, files), /different results/);
    assert.equal(files[0].text, body);
  } finally { globalThis.structuredClone = clone; JSON.stringify = stringify; }
});

test('P1 5: unknown numeric null and boolean front matter stays text', () => {
  const raw = '---\ncode: "001"\nempty: null\nflag: true\nnegative: false\nyes_word: yes\nzero: 0\n---\nInvented body\n';
  const result = checkSource(source, [{ path: 'one.md', text: raw }]);
  const note = toNotes(result.items, { source, importedAt }).notes[0];
  for (const [key, expected] of Object.entries({ code: '001', empty: 'null', flag: 'true', negative: 'false', yes_word: 'yes', zero: '0' })) {
    const value = new RegExp(`^  ${key}: (.+)$`, 'm').exec(note.text)?.[1];
    assert.equal(value, JSON.stringify(expected), key);
    assert.equal(JSON.parse(value), expected);
  }
});
