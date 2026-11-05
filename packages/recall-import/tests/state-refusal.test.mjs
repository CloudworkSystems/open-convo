import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runImport } from '../src/import.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-state-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'one.md'), '# Invented original\n');
  const args = ['--in', input, '--atlas', atlas, '--imported-at', '2026-11-05T12:00:00.000Z']; runImport([...args, '--write']);
  fs.writeFileSync(path.join(input, 'one.md'), '# Invented changed\n');
  return { input, atlas, args, dir: path.join(atlas, 'sources/recall') };
}
function snapshot(root) {
  const result = {};
  function walk(folder) { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name), key = path.relative(root, file); if (entry.isDirectory()) { result[key] = 'directory'; walk(file); } else result[key] = sha(fs.readFileSync(file)); } }
  walk(root); return result;
}
const stateFiles = [
  ['manifest', '.import-manifest.json', true], ['journal', '.import-journal.jsonl', true],
  ['lock', '.import.lock', true], ['reclaim', '.import.lock.reclaim', true],
  ['note', 'one.md', false], ['temp note', '.import-note-tmp-invented/data', false],
  ['temp manifest', '.import-manifest-tmp-invented/data', true], ['temp lock', '.import-lock-tmp-invented/data', true]
];
for (const [label, relative, structured] of stateFiles) for (const failure of ['bad JSON', 'wrong schema', 'directory', 'permission denied']) {
  if (label === 'lock' && failure === 'bad JSON') continue; // Carried 13 recovers this case.
  if (!structured && ['bad JSON', 'wrong schema'].includes(failure)) continue; // Notes have no JSON schema.
  test(`State refusal table: ${label}, ${failure}, dry and write preserve every Atlas byte`, t => {
    if (failure === 'permission denied' && process.getuid?.() === 0) { t.skip('Root bypasses file permissions'); return; }
    const f = fixture(), target = path.join(f.dir, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (failure === 'directory') { if (fs.existsSync(target)) fs.unlinkSync(target); fs.mkdirSync(target); }
    else if (failure === 'bad JSON') fs.writeFileSync(target, '{broken\n');
    else if (failure === 'wrong schema') fs.writeFileSync(target, '{}\n');
    else {
      if (!fs.existsSync(target)) fs.writeFileSync(target, label.includes('lock') || label === 'reclaim' ? JSON.stringify({ pid: 2147483647, host: os.hostname() }) : label === 'journal' ? '' : 'Invented saved bytes');
    }
    const before = snapshot(f.atlas);
    for (const write of [false, true]) {
      if (failure === 'permission denied') fs.chmodSync(target, 0);
      try { assert.throws(() => runImport(write ? [...f.args, '--write'] : f.args), error => { assert.ok(error.message.includes(target), error.message); assert.match(error.message, /restore|move.*aside/i); return true; }); }
      finally { if (failure === 'permission denied') fs.chmodSync(target, 0o600); }
      assert.deepEqual(snapshot(f.atlas), before, `${label}, ${failure}, ${write ? 'write' : 'dry'}`);
    }
  });
}

test('State refusal table: wrong manifest version preserves every byte in both modes', () => {
  const f = fixture(), file = path.join(f.dir, '.import-manifest.json'), manifest = JSON.parse(fs.readFileSync(file)); manifest.version = 99; fs.writeFileSync(file, JSON.stringify(manifest));
  const before = snapshot(f.atlas);
  for (const write of [false, true]) { assert.throws(() => runImport(write ? [...f.args, '--write'] : f.args), error => error.message.includes(file)); assert.deepEqual(snapshot(f.atlas), before); }
});
test('State refusal table: bad non-final journal line, wrong version and contradictory journal preserve every byte', () => {
  for (const kind of ['bad non-final', 'wrong version', 'contradiction']) {
    const f = fixture(), file = path.join(f.dir, '.import-journal.jsonl');
    const entry = JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json'))).entries['one.md'];
    fs.writeFileSync(file, kind === 'bad non-final' ? '{broken\n{}\n' : kind === 'wrong version' ? JSON.stringify({ version: 99, key: 'one.md', entry }) + '\n' : JSON.stringify({ key: 'one.md', entry: { ...entry, path: 'sources/recall/other.md' } }) + '\n');
    const before = snapshot(f.atlas);
    for (const write of [false, true]) { assert.throws(() => runImport(write ? [...f.args, '--write'] : f.args), error => error.message.includes(file)); assert.deepEqual(snapshot(f.atlas), before); }
  }
});

test('State refusal table: duplicate ownership fields and journal baseline mismatch refuse unchanged', () => {
  for (const kind of ['duplicates', 'baseline']) {
    const f = fixture(), manifestFile = path.join(f.dir, '.import-manifest.json');
    const file = kind === 'duplicates' ? manifestFile : path.join(f.dir, '.import-journal.jsonl');
    if (kind === 'duplicates') fs.writeFileSync(file, '{"version":1,"entries":{},"entries":{},"pending":{}}');
    else {
      const entry = JSON.parse(fs.readFileSync(manifestFile)).entries['one.md'];
      fs.writeFileSync(file, JSON.stringify({ key: 'one.md', entry: { ...entry, fullHash: '1'.repeat(64) }, previous: { ...entry, fullHash: '2'.repeat(64) } }) + '\n');
    }
    const before = snapshot(f.atlas);
    for (const write of [false, true]) { assert.throws(() => runImport(write ? [...f.args, '--write'] : f.args), error => error.message.includes(file)); assert.deepEqual(snapshot(f.atlas), before); }
  }
});

test('State refusal table: leftover folder read failure refuses before every write', t => {
  if (process.getuid?.() === 0) { t.skip('Root bypasses directory permissions'); return; }
  const f = fixture(), folder = path.join(f.dir, '.import-note-tmp-invented'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'data'), 'Invented bytes');
  const before = snapshot(f.atlas);
  for (const write of [false, true]) {
    fs.chmodSync(folder, 0);
    try { assert.throws(() => runImport(write ? [...f.args, '--write'] : f.args), error => error.message.includes(folder)); }
    finally { fs.chmodSync(folder, 0o700); }
    assert.deepEqual(snapshot(f.atlas), before);
  }
});

test('State refusal table: non-ENOENT I/O failures never become missing state', () => {
  for (const [, relative] of stateFiles) {
    const f = fixture(), target = path.join(f.dir, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, 'Invented saved bytes');
    const before = snapshot(f.atlas), read = fs.readFileSync;
    for (const write of [false, true]) {
      fs.readFileSync = (file, ...args) => { if (file === target) { const error = Error('Simulated I/O failure'); error.code = 'EIO'; throw error; } return read(file, ...args); };
      try { assert.throws(() => runImport(write ? [...f.args, '--write'] : f.args), error => error.message.includes(target) && /Restore.*move.*aside/.test(error.message)); }
      finally { fs.readFileSync = read; }
      assert.deepEqual(snapshot(f.atlas), before);
    }
  }
});
