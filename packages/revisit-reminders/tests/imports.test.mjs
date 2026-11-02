import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(srcDir).filter(name => name.endsWith('.mjs')).sort();

const LIBRARY = files.filter(name => name !== 'command.mjs' && name !== 'revisit.mjs');
const COMMAND = ['command.mjs', 'revisit.mjs'];

function specifiers(source) {
  const found = [];
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) found.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(match[1]);
  for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  for (const match of source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  return found;
}

function bare(specifier) {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

function strip(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NETWORK = new Set([
  'child_process', 'net', 'dns', 'dns/promises', 'http', 'https', 'http2', 'tls',
  'dgram', 'cluster', 'worker_threads', 'inspector', 'inspector/promises',
]);

test('the library imports no fs, network or child_process module', () => {
  assert.deepEqual(LIBRARY, [
    'dates.mjs', 'errors.mjs', 'index.mjs', 'reminder.mjs', 'saved.mjs', 'text.mjs', 'view.mjs',
  ]);
  for (const name of LIBRARY) {
    const source = readFileSync(new URL(name, new URL('../src/', import.meta.url)), 'utf8');
    const loaded = specifiers(source).map(bare);
    for (const specifier of loaded) {
      assert.equal(specifier === 'fs' || specifier.startsWith('fs/'), false, `${name} imports ${specifier}`);
      assert.equal(NETWORK.has(specifier), false, `${name} imports ${specifier}`);
    }
    assert.equal(loaded.every(specifier => specifier.startsWith('.')), true, `${name}: ${loaded.join(', ')}`);
    const code = strip(source);
    assert.doesNotMatch(code, /Date\.now|new\s+Date\s*\(|\bfetch\s*\(|child_process|process\.exit\s*\(/);
    assert.doesNotMatch(source, /createRequire|getBuiltinModule/);
  }
});

test('the command imports no network or child_process module', () => {
  const command = readFileSync(new URL('../src/command.mjs', import.meta.url), 'utf8');
  assert.match(command, /import \{ closeSync, fstatSync, openSync, readFileSync \} from 'node:fs'/);
  const loaded = specifiers(command).map(bare);
  assert.deepEqual(loaded.filter(specifier => specifier === 'fs' || specifier.startsWith('fs/')), ['fs']);
  for (const specifier of loaded) assert.equal(NETWORK.has(specifier), false, specifier);
  assert.doesNotMatch(strip(command), /Date\.now|new\s+Date\s*\(|\bfetch\s*\(|child_process|process\.exit\s*\(/);
  assert.doesNotMatch(command, /writeFile|appendFile|createWriteStream|mkdir|rmSync|unlink/);

  const entry = readFileSync(new URL('../src/revisit.mjs', import.meta.url), 'utf8');
  const entryLoads = specifiers(entry).map(bare);
  assert.deepEqual(entryLoads, ['url', './command.mjs']);
  assert.doesNotMatch(strip(entry), /Date\.now|new\s+Date\s*\(|\bfetch\s*\(|child_process|process\.exit\s*\(/);
  assert.match(entry, /process\.exitCode/);
  assert.deepEqual(COMMAND, ['command.mjs', 'revisit.mjs']);
});
