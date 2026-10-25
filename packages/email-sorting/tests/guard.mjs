// Shared test setup: blocks every network and process entry point Node 22's
// built-in modules offer (the list in docs/plans/visibility-report.md, test
// 11). Each stub records the call and throws. Every test file imports this
// first; after each test it asserts that nothing was called.

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import cluster from 'node:cluster';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import inspector from 'node:inspector';
import inspectorPromises from 'node:inspector/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import tlsWrap from 'node:_tls_wrap';
import workerThreads from 'node:worker_threads';
import { afterEach } from 'node:test';

const calls = [];

function blocker(name) {
  return function blocked() {
    calls.push(name);
    throw new Error(`Blocked in tests: ${name} (no network and no processes).`);
  };
}

function stub(target, prefix, names) {
  for (const name of names) {
    if (typeof target[name] === 'function') target[name] = blocker(`${prefix}.${name}`);
  }
}

function resolveNames(target) {
  return Object.keys(target).filter(name => name === 'lookup' || name === 'lookupService' || name.startsWith('resolve'));
}

export const STUBBED = Object.freeze([
  'fetch', 'WebSocket', 'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises',
  'inspector', 'inspector/promises', 'child_process', 'cluster', 'worker_threads', '_tls_wrap',
]);

globalThis.fetch = blocker('fetch');
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = blocker('WebSocket');

stub(net, 'net', ['connect', 'createConnection']);
net.Socket.prototype.connect = blocker('net.Socket.prototype.connect');
// Listening on a port is network too (http and https servers inherit this).
net.Server.prototype.listen = blocker('net.Server.prototype.listen');
stub(tls, 'tls', ['connect']);
tls.TLSSocket.prototype.connect = blocker('tls.TLSSocket.prototype.connect');
stub(tlsWrap, '_tls_wrap', ['connect']);
stub(http, 'http', ['request', 'get']);
stub(https, 'https', ['request', 'get']);
stub(http2, 'http2', ['connect']);
stub(dgram, 'dgram', ['createSocket']);
stub(dns, 'dns', resolveNames(dns));
stub(dns.promises, 'dns.promises', resolveNames(dns.promises));
stub(dnsPromises, 'dns/promises', resolveNames(dnsPromises));
stub(inspector, 'inspector', ['open']);
stub(inspectorPromises, 'inspector/promises', ['open']);
stub(childProcess, 'child_process', ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']);
stub(cluster, 'cluster', ['fork']);
workerThreads.Worker = blocker('worker_threads.Worker');

// If an undici package is ever importable, block it too.
try {
  const undici = await import('undici');
  const target = undici.default ?? undici;
  for (const name of ['fetch', 'request', 'stream', 'connect', 'Client', 'Pool', 'Agent']) {
    try { target[name] = blocker(`undici.${name}`); } catch { /* read-only namespace */ }
  }
} catch {
  // Not installed: nothing to block.
}

syncBuiltinESMExports();

// Returns and clears the recorded calls (for the tests that call a blocked
// entry point on purpose).
export function takeCalls() {
  return calls.splice(0, calls.length);
}

afterEach(() => {
  assert.deepEqual(takeCalls(), [], 'a network or process entry point was called');
});
