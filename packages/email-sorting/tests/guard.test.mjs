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

// Names are compared without the "node:" prefix: newer Node releases list
// prefix-only modules (node:sea, node:sqlite, node:test, ...) that way.
// The snapshot is the union of every release the package supports (Node 22
// and later; checked against 22 and 26). A module a release drops is fine;
// one the snapshot doesn't know fails the test.
function unlisted(names) {
  return names.map(name => name.replace(/^node:/, '')).filter(name => !Object.hasOwn(SNAPSHOT, name));
}

// Node 26's builtinModules, as printed by that release.
const NODE_26 = ['_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_tls_common', '_tls_wrap', 'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises',
  'http', 'http2', 'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream',
  'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls',
  'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  'node:sea', 'node:sqlite', 'node:test', 'node:test/reporters'];

test('15. every Node built-in module is in the snapshot, marked network or not', () => {
  const marks = new Set(['network or process: stubbed above', 'no network']);
  assert.deepEqual(unlisted(builtinModules), [],
    'a built-in is not in tests/builtin-modules.json; add its entry points to tests/guard.mjs first');
  for (const mark of Object.values(SNAPSHOT)) assert.ok(marks.has(mark), `unknown mark ${JSON.stringify(mark)}`);
  for (const [name, mark] of Object.entries(SNAPSHOT)) {
    if (mark === 'network or process: stubbed above') {
      assert.ok(STUBBED.includes(name) || name.startsWith('_http_'), `"${name}" is marked stubbed but the guard doesn't list it`);
    }
  }
});

test('15. the snapshot covers later supported releases, including node:-prefixed modules', () => {
  assert.deepEqual(unlisted(NODE_26), []);
  assert.deepEqual(unlisted(['node:sqlite', 'node:brand-new']), ['brand-new'], 'an unknown module still fails');
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
