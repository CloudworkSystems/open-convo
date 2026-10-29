// Blocks network and process entry points, and records any file write that
// comes from the library. Node 22's permission model has no network
// permission, so the tests deny those entry points instead.

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import cluster from 'node:cluster';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import inspector from 'node:inspector';
import inspectorPromises from 'node:inspector/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import { afterEach } from 'node:test';

const calls = [];
const writes = [];

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

function fromLibrary(stack) {
  return stack.includes('/packages/today-agenda/src/');
}

function noteWrite(name) {
  const stack = new Error().stack ?? '';
  if (!fromLibrary(stack)) return;
  writes.push(name);
  throw new Error(`Blocked write from the library: ${name}`);
}

function guardWrite(target, name) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = function guardedWrite(...args) {
    noteWrite(`fs.${name}`);
    return original.apply(this, args);
  };
}

const realOpenSync = fs.openSync;
fs.openSync = function openSync(path, flags, ...rest) {
  const writing = typeof flags === 'number' ? (flags & 3) !== 0 : /[wa+]/.test(String(flags));
  if (writing) noteWrite('fs.openSync');
  return realOpenSync(path, flags, ...rest);
};

for (const name of [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'truncate', 'truncateSync', 'rm', 'rmSync', 'unlink', 'unlinkSync',
  'mkdir', 'mkdirSync', 'copyFile', 'copyFileSync', 'rename', 'renameSync',
]) {
  guardWrite(fs, name);
  guardWrite(fs.promises, name);
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
stub(inspectorPromises, 'inspector/promises', ['open']);
stub(childProcess, 'child_process', ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']);
stub(cluster, 'cluster', ['fork']);
workerThreads.Worker = blocker('worker_threads.Worker');

syncBuiltinESMExports();

export function takeCalls() {
  return calls.splice(0, calls.length);
}

export function takeWrites() {
  return writes.splice(0, writes.length);
}

afterEach(() => {
  assert.deepEqual(takeCalls(), [], 'a network or process entry point was called');
  assert.deepEqual(takeWrites(), [], 'the library wrote a file');
});
