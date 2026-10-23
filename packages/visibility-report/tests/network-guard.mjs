/**
 * Blocks every network and process entry point the visibility report plan
 * names, before any test file imports them. Node 22's permission model has
 * no network permission, so the tests stub the entry points instead.
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

function blockedClass(name) {
  return class BlockedEntry {
    constructor() {
      networkCalls.push({ name });
      throw new Error(`Network blocked: ${name}`);
    }
  };
}

function install(specifier, real, overrides) {
  const named = { ...real, ...overrides };
  if (real.default && typeof real.default === 'object') {
    named.default = { ...real.default, ...overrides };
  }
  mock.module(specifier, { namedExports: named });
}

function stubFunctions(real, prefix, names) {
  const overrides = {};
  for (const name of names) {
    if (typeof real[name] === 'function') overrides[name] = block(`${prefix}.${name}`);
  }
  return overrides;
}

globalThis.fetch = block('fetch');
globalThis.WebSocket = blockedClass('WebSocket');

net.Socket.prototype.connect = block('net.Socket.prototype.connect');
net.Server.prototype.listen = block('net.Server.prototype.listen');
tls.TLSSocket.prototype.connect = block('tls.TLSSocket.prototype.connect');

install('node:net', net, {
  connect: block('net.connect'),
  createConnection: block('net.createConnection'),
});
install('node:tls', tls, {
  connect: block('tls.connect'),
});
install('node:http', http, {
  request: block('http.request'),
  get: block('http.get'),
});
install('node:https', https, {
  request: block('https.request'),
  get: block('https.get'),
});
install('node:http2', http2, {
  connect: block('http2.connect'),
});
const BlockedSocket = blockedClass('dgram.Socket');
for (const name of [
  'bind',
  'connect',
  'disconnect',
  'send',
  'sendto',
  'addMembership',
  'dropMembership',
  'addSourceSpecificMembership',
  'dropSourceSpecificMembership',
]) {
  if (typeof dgram.Socket?.prototype?.[name] === 'function') {
    BlockedSocket.prototype[name] = block(`dgram.Socket.prototype.${name}`);
  }
}
install('node:dgram', dgram, {
  createSocket: block('dgram.createSocket'),
  _createSocketHandle: block('dgram._createSocketHandle'),
  Socket: BlockedSocket,
});

function isDnsQuery(name) {
  return name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve');
}

const dnsNames = Object.keys(dns).filter(isDnsQuery);
const dnsPromiseNames = Object.keys(dnsPromises).filter(isDnsQuery);

function stubResolverPrototype(Resolver, prefix, names) {
  const prototype = Resolver?.prototype;
  if (!prototype) return;
  for (const name of names) {
    if (typeof prototype[name] === 'function') prototype[name] = block(`${prefix}.${name}`);
  }
}

stubResolverPrototype(dns.Resolver, 'dns.Resolver.prototype', dnsNames);
stubResolverPrototype(dnsPromises.Resolver, 'dns/promises.Resolver.prototype', dnsPromiseNames);
install('node:dns/promises', dnsPromises, stubFunctions(dnsPromises, 'dns/promises', dnsPromiseNames));
install('node:dns', dns, {
  ...stubFunctions(dns, 'dns', dnsNames),
  promises: { ...dns.promises, ...stubFunctions(dnsPromises, 'dns/promises', dnsPromiseNames) },
});

install('node:inspector', inspector, { open: block('inspector.open') });
install('node:inspector/promises', inspectorPromises, { open: block('inspector/promises.open') });

const childNames = ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync', 'forkSync'];
install('node:child_process', childProcess, stubFunctions(childProcess, 'child_process', childNames));
install('node:cluster', cluster, { fork: block('cluster.fork') });
install('node:worker_threads', workerThreads, { Worker: blockedClass('worker_threads.Worker') });

try {
  const undici = await import('undici');
  const overrides = stubFunctions(undici, 'undici', ['fetch', 'request', 'stream', 'connect']);
  for (const name of ['Client', 'Pool', 'Agent']) {
    if (typeof undici[name] === 'function') overrides[name] = blockedClass(`undici.${name}`);
  }
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
