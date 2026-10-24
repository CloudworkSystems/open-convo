/**
 * Blocks every callable export of the network and process built-ins before
 * any test file imports them. Node 22's permission model has no network
 * permission, so the tests deny those entry points instead.
 *
 * A callable export throws, whether it is reached through `node:`, through
 * `process.getBuiltinModule`, or as a global (`fetch`, `WebSocket`,
 * `EventSource`). Non-function exports are left as they are.
 */
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
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import { mock, afterEach } from 'node:test';

export const networkCalls = [];

export const STUBBED_MODULES = Object.freeze([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'dns/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'net',
  'tls',
  'worker_threads',
]);

function block(name) {
  return function blockedEntry() {
    networkCalls.push({ name });
    throw new Error(`Network blocked: ${name}`);
  };
}

export function clearNetworkCalls() {
  networkCalls.length = 0;
}

function assignExport(target, name, value) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return;
  try {
    target[name] = value;
    if (target[name] === value) return;
  } catch {
    // A getter such as dns.promises has no setter. Replace it below.
  }
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  if (target[name] !== value) throw new Error(`Could not block ${name}.`);
}

function install(specifier, real, overrides) {
  // process.getBuiltinModule returns this same object, not the ESM mock.
  for (const [name, value] of Object.entries(overrides)) {
    assignExport(real, name, value);
    if (real.default && typeof real.default === 'object' && real.default !== real) {
      assignExport(real.default, name, value);
    }
  }
  const named = { ...real, ...overrides };
  if (real.default && typeof real.default === 'object') {
    named.default = { ...real.default, ...overrides };
  }
  mock.module(specifier, { namedExports: named });
}

function denyCallables(real, prefix) {
  const overrides = {};
  for (const name of Object.getOwnPropertyNames(real)) {
    if (name === 'default') continue;
    let value;
    try {
      value = real[name];
    } catch {
      continue;
    }
    if (typeof value === 'function') overrides[name] = block(`${prefix}.${name}`);
  }
  return overrides;
}

function denyModule(prefix, real) {
  install(`node:${prefix}`, real, denyCallables(real, prefix));
}

globalThis.fetch = block('fetch');
globalThis.WebSocket = block('WebSocket');
globalThis.EventSource = block('EventSource');

// dns.promises is the dns/promises module object. Deny that object first so
// the getter on dns already points at blocked functions.
denyModule('dns/promises', dnsPromises);
denyModule('dns', dns);
denyModule('net', net);
denyModule('tls', tls);
denyModule('dgram', dgram);
denyModule('http', http);
denyModule('https', https);
denyModule('http2', http2);
denyModule('inspector', inspector);
denyModule('inspector/promises', inspectorPromises);
denyModule('child_process', childProcess);
denyModule('cluster', cluster);
denyModule('worker_threads', workerThreads);

try {
  const undici = await import('undici');
  const overrides = denyCallables(undici, 'undici');
  if (Object.keys(overrides).length > 0) install('undici', undici, overrides);
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

afterEach(() => {
  if (networkCalls.length === 0) return;
  const names = networkCalls.map((call) => call.name).join(', ');
  networkCalls.length = 0;
  throw new Error(`A network or process entry point was called: ${names}`);
});
