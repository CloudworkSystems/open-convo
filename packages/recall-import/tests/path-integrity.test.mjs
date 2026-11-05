import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { recallSource, toNotes } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';
const source = recallSource(), importedAt = '2026-11-05T12:00:00.000Z';
const pairs = [['exact', 'same.md', 'same.md'], ['case', 'Same.md', 'same.md'], ['Unicode', 'caf\u00e9.md', 'cafe\u0301.md']];
const snapshot = root => {
  const saved = new Map();
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) { saved.set(file, 'directory'); walk(file); } else saved.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')); } }
  walk(root); return saved;
};
for (const [name, a, b] of pairs) test(`Manifest path integrity table: ${name} duplicates refuse before candidates and leave disk unchanged`, () => {
  const manifest = { 'first.md': { path: `sources/recall/${a}` }, 'second.md': { path: `sources/recall/${b}` } };
  assert.throws(() => toNotes([], { source, importedAt, manifest }), error => /manifest/i.test(error.message) && error.message.includes('first.md') && error.message.includes('second.md'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-path-integrity-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'first.md'), '# First'); fs.writeFileSync(path.join(input, 'second.md'), '# Second');
  const args = ['--in', input, '--atlas', atlas, '--imported-at', importedAt]; runImport([...args, '--write']);
  const file = path.join(atlas, 'sources/recall/.import-manifest.json'), saved = JSON.parse(fs.readFileSync(file));
  saved.entries['first.md'].path = manifest['first.md'].path; saved.entries['second.md'].path = manifest['second.md'].path; fs.writeFileSync(file, JSON.stringify(saved));
  const before = snapshot(atlas);
  for (const flags of [[], ['--write']]) {
    assert.throws(() => runImport([...args, ...flags]), error => error.message.includes(file) && error.message.includes('first.md') && error.message.includes('second.md') && /Restore.*move.*aside/.test(error.message));
    assert.deepEqual(snapshot(atlas), before);
  }
});
