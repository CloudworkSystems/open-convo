// What the package's own code may reach (packages/AGENTS.md and
// docs/plans/push-gate.md): GitHub only, and nothing Mac-only. Keychain and
// 1Password stay behind the seam in scripts/push-gate/.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (folder) =>
  readdirSync(new URL(folder, import.meta.url))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => readFileSync(new URL(`${folder}${name}`, import.meta.url), 'utf8'))
    .join('\n');

test('the package reaches GitHub only and leaves Keychain and 1Password to the seam', () => {
  const source = read('../src/');
  const hosts = [...source.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)].sort(), ['api.github.com', 'github.com']);
  assert.doesNotMatch(source, /find-generic-password|OP_SERVICE_ACCOUNT|\bop document\b|from ['"][^'"]*(apps|scripts)\//);
  assert.doesNotMatch(source, /--force|force-with-lease/);
});

test('the tests use no host beyond 127.0.0.1 and names GitHub gives back', () => {
  const tests = `${read('./')}\n${read('./helpers/')}`;
  const hosts = [...tests.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)].sort(), ['127.0.0.1', 'github.com']);
});
