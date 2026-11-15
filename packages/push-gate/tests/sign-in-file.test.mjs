// The gate refuses a sign-in file anyone else can read
// (docs/plans/push-gate.md, "Running").

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSignInFile } from '../src/sign-in-file.mjs';

test('a sign-in file only its owner can read is read; one others can read is refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-sign-in-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sign-in');
  writeFileSync(file, 'an-invented-sign-in\n', { mode: 0o600 });

  assert.equal(readSignInFile(file), 'an-invented-sign-in');

  for (const mode of [0o640, 0o604, 0o644, 0o660, 0o606]) {
    chmodSync(file, mode);
    assert.throws(() => readSignInFile(file), /can be read by others/, mode.toString(8));
  }
  chmodSync(file, 0o600);
  assert.throws(() => readSignInFile(file, { uid: process.getuid() + 1 }), /belongs to another user/);
  symlinkSync(file, join(dir, 'link'));
  assert.throws(() => readSignInFile(join(dir, 'link')), /can't be opened/);
  assert.throws(() => readSignInFile(join(dir, 'missing')), /can't be opened/);
  assert.throws(() => readSignInFile(dir), /isn't a plain file/);
  // No failure repeats what the file holds.
  chmodSync(file, 0o644);
  assert.throws(() => readSignInFile(file), (error) => !error.message.includes('invented'));
});
