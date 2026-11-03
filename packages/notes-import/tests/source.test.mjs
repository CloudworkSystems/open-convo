import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const library = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
const command = readFileSync(new URL('../src/import.mjs', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the library imports household lists only through the public export', () => {
  const imports = library.split('\n').filter(line => line.startsWith('import '));
  assert.deepEqual(imports, ["import { HouseholdLists } from '../../household-lists/src/index.mjs';"]);
});

test('the library and the command do not read a clock, a network, or a process', () => {
  const banned = ['child_process', 'node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'fetch(', 'Date', 'hrtime', 'performance', 'setTimeout', 'setInterval', 'Math.random'];
  for (const word of banned) {
    assert.equal(library.includes(word), false, `library ${word}`);
    assert.equal(command.includes(word), false, `command ${word}`);
  }
  for (const word of ['node:fs', "from 'fs'", 'from "fs"']) {
    assert.equal(library.includes(word), false, `library ${word}`);
  }
  assert.equal(command.includes("from 'node:fs'"), true);
});

test('the package has no dependencies and no license field', () => {
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.scripts.test, 'node --test');
  assert.equal(Object.hasOwn(manifest, 'license'), false);
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false);
});
