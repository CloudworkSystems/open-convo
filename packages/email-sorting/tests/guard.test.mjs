import { STUBBED, takeCalls } from './guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { builtinModules, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { test } from 'node:test';
import { createKeywordClassifier, formatSummary, sortMessages } from '../src/index.mjs';
import { FIXTURE, FIXTURE_SETTINGS, readJson } from './helpers.mjs';

const SNAPSHOT = readJson(new URL('./builtin-modules.json', import.meta.url));

// ------------------------------------------------------------------ test 15
test('15. the guard throws when fetch is called on purpose', async () => {
  assert.throws(() => fetch('https://example.com/'), /Blocked in tests: fetch/);
  assert.deepEqual(takeCalls(), ['fetch']);
});

test('15. the guard throws when net.connect is called on purpose', () => {
  assert.throws(() => net.connect(80, 'example.com'), /Blocked in tests: net\.connect/);
  assert.throws(() => new net.Socket().connect(80, 'example.com'), /Blocked in tests: net\.Socket\.prototype\.connect/);
  assert.deepEqual(takeCalls(), ['net.connect', 'net.Socket.prototype.connect']);
});

test('15. every Node built-in module is in the snapshot, marked network or not', () => {
  const marks = new Set(['network or process: stubbed above', 'no network']);
  for (const name of builtinModules) {
    assert.ok(Object.hasOwn(SNAPSHOT, name), `built-in "${name}" is not in tests/builtin-modules.json; add its entry points to tests/guard.mjs first`);
    assert.ok(marks.has(SNAPSHOT[name]), `built-in "${name}" has an unknown mark`);
  }
  for (const [name, mark] of Object.entries(SNAPSHOT)) {
    if (mark === 'network or process: stubbed above' && builtinModules.includes(name)) {
      assert.ok(STUBBED.includes(name) || name.startsWith('_http_'), `"${name}" is marked stubbed but the guard doesn't list it`);
    }
  }
});

test('15. the library writes no files and opens no network while sorting', async () => {
  const writers = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync',
    'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'unlink', 'unlinkSync',
    'truncate', 'truncateSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'open', 'openSync', 'cp', 'cpSync'];
  const promiseWriters = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rename', 'copyFile', 'unlink', 'truncate', 'symlink', 'link', 'open', 'cp'];
  const saved = new Map();
  const touched = [];
  const replace = (target, label, name) => {
    if (typeof target[name] !== 'function') return;
    saved.set(`${label}.${name}`, [target, name, target[name]]);
    target[name] = () => { touched.push(`${label}.${name}`); throw new Error(`file write: ${label}.${name}`); };
  };
  for (const name of writers) replace(fs, 'fs', name);
  for (const name of promiseWriters) replace(fsPromises, 'fs/promises', name);
  syncBuiltinESMExports();
  const mailbox = readJson(FIXTURE);
  const config = readJson(FIXTURE_SETTINGS);
  let result;
  try {
    result = await sortMessages(mailbox, config, createKeywordClassifier());
    formatSummary(result);
  } finally {
    for (const [target, name, original] of saved.values()) target[name] = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(touched, []);
  assert.equal(result.schemaVersion, 1);
});
