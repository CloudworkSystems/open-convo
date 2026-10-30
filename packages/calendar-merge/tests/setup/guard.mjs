// Shared test setup, imported first by every test file. It blocks every
// network and process entry point Node 22's built-in modules offer (Node 22's
// permission model has no network permission, so the entry points are
// replaced instead), and every fs call that writes, so a test fails if the
// engine tries either. After each test it checks that none was called.
//
// Built-in modules are patched in place and synced to their ESM exports, so
// `import { connect } from 'node:net'` and process.getBuiltinModule() both
// see the stubs.

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach } from 'node:test';

const require = createRequire(import.meta.url);
export const blockedCalls = [];

export const STUBBED_MODULES = Object.freeze([
  'child_process', 'cluster', 'dgram', 'dns', 'dns/promises', 'http', 'http2', 'https',
  'inspector', 'inspector/promises', 'net', 'tls', 'worker_threads',
]);

function block(name) {
  return function blocked() {
    blockedCalls.push(name);
    throw new Error(`Blocked in tests: ${name}`);
  };
}

function blockedClass(name) {
  return class Blocked {
    constructor() {
      blockedCalls.push(name);
      throw new Error(`Blocked in tests: ${name}`);
    }
  };
}

function replace(target, name, value) {
  if (!target) return;
  try {
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: true });
  } catch {
    target[name] = value;
  }
}

function stubAll(moduleName, names) {
  const mod = require(moduleName);
  for (const name of names) if (typeof mod[name] === 'function') replace(mod, name, block(`${moduleName}.${name}`));
  return mod;
}

const isDnsQuery = (name) => name === 'lookup' || name === 'lookupService' || name === 'reverse' || name.startsWith('resolve');

// Globals.
replace(globalThis, 'fetch', block('fetch'));
replace(globalThis, 'WebSocket', blockedClass('WebSocket'));
if (typeof globalThis.EventSource === 'function') replace(globalThis, 'EventSource', blockedClass('EventSource'));

// Sockets and servers.
const net = stubAll('net', ['connect', 'createConnection']);
net.Socket.prototype.connect = block('net.Socket.prototype.connect');
net.Server.prototype.listen = block('net.Server.prototype.listen');
const tls = stubAll('tls', ['connect']);
tls.TLSSocket.prototype.connect = block('tls.TLSSocket.prototype.connect');
stubAll('http', ['request', 'get']);
stubAll('https', ['request', 'get']);
stubAll('http2', ['connect']);
const dgram = stubAll('dgram', ['createSocket', '_createSocketHandle']);
for (const name of ['bind', 'connect', 'send']) dgram.Socket.prototype[name] = block(`dgram.Socket.prototype.${name}`);

// Name lookups.
const dns = require('dns');
const dnsPromises = require('dns/promises');
stubAll('dns', Object.keys(dns).filter(isDnsQuery));
stubAll('dns/promises', Object.keys(dnsPromises).filter(isDnsQuery));
for (const name of Object.keys(dnsPromises).filter(isDnsQuery)) replace(dns.promises, name, block(`dns/promises.${name}`));
for (const [Resolver, prefix] of [[dns.Resolver, 'dns.Resolver'], [dnsPromises.Resolver, 'dns/promises.Resolver']]) {
  for (const name of Object.getOwnPropertyNames(Resolver.prototype).filter(isDnsQuery)) Resolver.prototype[name] = block(`${prefix}.${name}`);
}

// The inspector listens on a port.
stubAll('inspector', ['open']);
stubAll('inspector/promises', ['open']);

// No child processes or workers: they would run without these stubs.
const childProcess = stubAll('child_process', ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']);
childProcess.ChildProcess.prototype.spawn = block('child_process.ChildProcess.prototype.spawn');
stubAll('cluster', ['fork']);
replace(require('worker_threads'), 'Worker', blockedClass('worker_threads.Worker'));

// Nothing written: every fs entry point that creates, changes or removes a file.
const fs = require('fs');
const WRITES = [
  'writeFile', 'appendFile', 'createWriteStream', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename',
  'copyFile', 'cp', 'symlink', 'link', 'truncate', 'ftruncate', 'chmod', 'chown', 'utimes', 'lchown', 'lutimes',
];
for (const name of WRITES) {
  if (typeof fs[name] === 'function') replace(fs, name, block(`fs.${name}`));
  if (typeof fs[`${name}Sync`] === 'function') replace(fs, `${name}Sync`, block(`fs.${name}Sync`));
  if (typeof fs.promises[name] === 'function') replace(fs.promises, name, block(`fs/promises.${name}`));
}
const realOpenSync = fs.openSync;
const realOpen = fs.open;
const readOnly = (flags) => flags === undefined || flags === 'r' || flags === fs.constants.O_RDONLY;
replace(fs, 'openSync', function openSync(file, flags, ...rest) {
  if (!readOnly(flags)) return block('fs.openSync for writing')();
  return realOpenSync(file, flags, ...rest);
});
replace(fs, 'open', function open(file, flags, ...rest) {
  if (typeof flags !== 'function' && !readOnly(flags)) return block('fs.open for writing')();
  return realOpen(file, flags, ...rest);
});

syncBuiltinESMExports();

export function takeBlockedCalls() {
  const calls = [...blockedCalls];
  blockedCalls.length = 0;
  return calls;
}

afterEach(() => {
  const calls = takeBlockedCalls();
  if (calls.length) throw new Error(`A blocked entry point was called: ${calls.join(', ')}`);
});
