import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function filesUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else if (name.endsWith('.mjs') || name.endsWith('.js') || name.endsWith('.json')) found.push(path);
  }
  return found;
}

test('the library does not touch files, the clock, or the network', () => {
  const source = filesUnder(join(root, 'src')).map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(source, /node:(?:fs|child_process|net|http|https|dgram)|from ['"](?:fs|child_process|net|http|https|dgram)['"]/);
  assert.doesNotMatch(source, /fs\/promises/);
  assert.doesNotMatch(source, /\bDate\b|hrtime|performance\.now/);
});

test('the command and the tests do not spawn processes or open the network', () => {
  const paths = [...filesUnder(join(root, 'bin')), ...filesUnder(join(root, 'tests'))];
  const source = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(source, /node:(?:child_process|net|http|https|dgram)|from ['"](?:child_process|net|http|https|dgram)['"]/);
  const command = readFileSync(join(root, 'bin', 'creator-proof.mjs'), 'utf8');
  assert.equal(command.match(/new Date/g).length, 1);
  assert.doesNotMatch(command, /Date\.now/);
});

test('the package has no dependencies and no license field', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
});
