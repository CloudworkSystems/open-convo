// Merge-gate practice (test 1): this test fails on purpose so the `tests`
// check fails. This pull request must never merge. Invented content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('gate scratch: a deliberately failing test', () => {
  assert.equal(1 + 1, 3);
});
