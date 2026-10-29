import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['fixtures', 'tests'].flatMap(dir => readdirSync(join(root, dir)).map(name => join(root, dir, name)));

test('fixtures and tests use only invented addresses and links on .example domains', () => {
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [address, domain] of text.matchAll(/[\w.+-]+@((?:[\w-]+\.)+[\w-]+)/g)) {
      assert.ok(domain.toLowerCase().endsWith('.example'), `${file}: ${address}`);
    }
    for (const [, host] of text.matchAll(/https?:\/\/([^/\s"'`]+)/g)) {
      assert.ok(host.toLowerCase().endsWith('.example'), `${file}: ${host}`);
    }
  }
});
