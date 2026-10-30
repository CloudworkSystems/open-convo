// Plan test 14: no network and nothing written. The shared setup
// (tests/setup/guard.mjs) blocks the entry points; these tests show it works.
import { STUBBED_MODULES, takeBlockedCalls } from './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import { builtinModules, createRequire } from 'node:module';
import { fixture } from './helpers.mjs';
import { formatAgenda, mergeCalendars } from '../src/index.mjs';

const require = createRequire(import.meta.url);
const snapshot = require('./setup/builtin-modules.json');

test('fetch is blocked', () => {
  assert.throws(() => fetch('https://calendar.example/feed.ics'), /Blocked in tests: fetch/);
  assert.deepEqual(takeBlockedCalls(), ['fetch']);
});

test('net.connect is blocked', () => {
  assert.throws(() => net.connect(443, 'calendar.example'), /Blocked in tests: net\.connect/);
  assert.deepEqual(takeBlockedCalls(), ['net.connect']);
});

test('every other network and process entry point is blocked', async () => {
  const tls = await import('node:tls');
  const http = await import('node:http');
  const https = await import('node:https');
  const http2 = await import('node:http2');
  const dgram = await import('node:dgram');
  const dns = await import('node:dns');
  const dnsPromises = await import('node:dns/promises');
  const inspector = await import('node:inspector');
  const childProcess = await import('node:child_process');
  const cluster = await import('node:cluster');
  const workerThreads = await import('node:worker_threads');
  const calls = [
    () => net.createConnection(443, 'calendar.example'),
    () => new net.Socket().connect(443, 'calendar.example'),
    () => net.createServer().listen(0),
    () => tls.connect(443, 'calendar.example'),
    () => http.get('http://calendar.example'),
    () => http.request('http://calendar.example'),
    () => https.get('https://calendar.example'),
    () => https.request('https://calendar.example'),
    () => http2.connect('https://calendar.example'),
    () => dgram.createSocket('udp4'),
    () => dns.lookup('calendar.example', () => {}),
    () => dns.resolve('calendar.example', () => {}),
    () => dnsPromises.lookup('calendar.example'),
    () => dnsPromises.resolve4('calendar.example'),
    () => new dns.Resolver().resolve4('calendar.example', () => {}),
    () => inspector.open(0),
    () => childProcess.spawn('true'),
    () => childProcess.execSync('true'),
    () => cluster.fork(),
    () => new workerThreads.Worker('0', { eval: true }),
    () => new WebSocket('wss://calendar.example'),
    () => process.getBuiltinModule('node:https').get('https://calendar.example'),
  ];
  for (const call of calls) assert.throws(call, /Blocked in tests/);
  assert.equal(takeBlockedCalls().length, calls.length);
});

test('file writes are blocked', () => {
  assert.throws(() => fs.writeFileSync('should-not-exist.txt', 'x'), /Blocked in tests: fs\.writeFileSync/);
  assert.throws(() => fs.openSync('should-not-exist.txt', 'w'), /Blocked in tests/);
  assert.throws(() => fs.promises.writeFile('should-not-exist.txt', 'x'), /Blocked in tests/);
  assert.equal(takeBlockedCalls().length, 3);
});

test('a full merge and agenda call no network, process or write entry point', async () => {
  const sources = ['home', 'family', 'work'].map((id) => ({ id, name: id, ics: fixture(`${id}.ics`) }));
  const result = await mergeCalendars(sources, { from: '2026-11-01', to: '2026-11-07', timeZone: 'America/New_York', includeCancelled: true });
  formatAgenda(result);
  assert.deepEqual(takeBlockedCalls(), []);
});

test('the built-in module snapshot covers every Node built-in, and the stubbed ones match the guard', () => {
  const known = new Set(snapshot.map((entry) => entry.name));
  // Newer Node versions also list prefix-only built-ins as "node:name" (Node 24:
  // node:sea, node:sqlite, node:test, node:test/reporters); the snapshot holds
  // them without the prefix.
  const missing = builtinModules.map((name) => name.replace(/^node:/, '')).filter((name) => !known.has(name));
  assert.deepEqual(missing, [], 'a new built-in module: decide whether it can reach the network, stub it in tests/setup/guard.mjs, then add it to the snapshot');
  const marks = new Set(['network or process: stubbed', 'network only through the stubbed net and tls entry points', 'no network']);
  for (const entry of snapshot) assert.ok(marks.has(entry.mark), entry.name);
  assert.deepEqual(snapshot.filter((e) => e.mark === 'network or process: stubbed').map((e) => e.name).sort(), [...STUBBED_MODULES].sort());
});
