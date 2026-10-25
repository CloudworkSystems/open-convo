// Blocks network and process entry points. Each stub records the call and throws.

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
import net from 'node:net';
import { afterEach } from 'node:test';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';

const calls = [];
function blocker(name) {
  return function blocked() {
    calls.push(name);
    throw new Error(`Blocked in tests: ${name} (no network and no processes).`);
  };
}
function stub(target, prefix, names) {
  for (const name of names) if (typeof target[name] === 'function') target[name] = blocker(`${prefix}.${name}`);
}
function resolveNames(target) {
  return Object.keys(target).filter(name => name === 'lookup' || name === 'lookupService' || name.startsWith('resolve'));
}

globalThis.fetch = blocker('fetch');
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = blocker('WebSocket');
stub(net, 'net', ['connect', 'createConnection']);
net.Socket.prototype.connect = blocker('net.Socket.prototype.connect');
net.Server.prototype.listen = blocker('net.Server.prototype.listen');
stub(tls, 'tls', ['connect']);
stub(http, 'http', ['request', 'get']);
stub(https, 'https', ['request', 'get']);
stub(http2, 'http2', ['connect']);
stub(dgram, 'dgram', ['createSocket']);
stub(dns, 'dns', resolveNames(dns));
stub(dns.promises, 'dns.promises', resolveNames(dns.promises));
stub(dnsPromises, 'dns/promises', resolveNames(dnsPromises));
stub(inspector, 'inspector', ['open']);
stub(childProcess, 'child_process', ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']);
stub(cluster, 'cluster', ['fork']);
workerThreads.Worker = blocker('worker_threads.Worker');

afterEach(() => {
  assert.deepEqual(calls.splice(0, calls.length), [], 'a network or process entry point was called');
});
