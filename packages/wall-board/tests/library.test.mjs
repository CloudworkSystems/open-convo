import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const LIBRARY_FORBIDDEN = [
  /node:fs/,
  /node:child_process/,
  /node:net/,
  /node:http/,
  /node:https/,
  /node:dns/,
  /node:tls/,
  /node:dgram/,
  /from 'fs'/,
  /from 'child_process'/,
  /Date\.now/,
  /new Date\(\)/,
  /performance\.now/,
  /process\.hrtime/,
  /\bfetch\(/,
];

describe('library limits', () => {
  it('does not import files, processes, the network or the clock', () => {
    const files = readdirSync(src).filter(name => name.endsWith('.mjs') && name !== 'board.mjs');
    assert.ok(files.includes('index.mjs'));
    for (const name of files) {
      const text = readFileSync(join(src, name), 'utf8');
      for (const pattern of LIBRARY_FORBIDDEN) {
        assert.equal(pattern.test(text), false, `${name} matches ${pattern}`);
      }
    }
  });

  it('keeps the command off the clock, processes and the network', () => {
    const text = readFileSync(join(src, 'board.mjs'), 'utf8');
    for (const pattern of LIBRARY_FORBIDDEN) {
      if (String(pattern) === String(/node:fs/) || String(pattern) === String(/from 'fs'/)) continue;
      assert.equal(pattern.test(text), false, `board.mjs matches ${pattern}`);
    }
    assert.match(text, /node:fs/);
    assert.match(text, /renameSync/);
  });
});
