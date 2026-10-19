// Merge-gate scratch test 2 (gate-test branch only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdult } from '../src/scratch/gate-scratch-age.mjs';

test('gate scratch: adults and children', () => {
  assert.equal(isAdult(30), true);
  assert.equal(isAdult(10), false);
  assert.equal(isAdult(18), true);
  assert.equal(isAdult(17), false);
});
