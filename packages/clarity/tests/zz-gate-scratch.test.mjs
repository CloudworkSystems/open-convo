// Merge-gate scratch test 1 (gate-test branch only): this test fails on
// purpose, so the required `tests` check fails and the PR must never merge.
import test from 'node:test';
import assert from 'node:assert/strict';

test('gate scratch: deliberately failing', () => {
  assert.equal(1 + 1, 3);
});
