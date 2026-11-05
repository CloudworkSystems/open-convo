import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyOperation, emptyState, read } from '../src/index.mjs';

test('Purge leaves no hash of purged text', () => {
  let state = emptyState([
    { id: 'personal', name: 'Invented Personal', kind: 'personal' },
    { id: 'studio', name: 'Invented Studio', kind: 'business' }
  ]);
  const apply = (type, data = {}) => {
    state = applyOperation(state, {
      id: `op-${state.log.length}`, actor: 'person',
      now: '2040-01-01T00:00:00Z', type, ...data
    }).state;
  };
  const keep = id => {
    apply('propose', { candidate: { id, text: 'middle' } });
    apply('keep', {
      candidateId: id, space: 'personal', subject: 'invented',
      label: { kind: 'owner said', date: '2040-01-01' }
    });
  };
  const hashesIn = value => {
    const hashes = new Set();
    const visit = item => {
      if (typeof item === 'string' && /^[0-9a-f]{64}$/i.test(item)) hashes.add(item.toLowerCase());
      else if (item && typeof item === 'object') {
        for (const [key, child] of Object.entries(item)) { visit(key); visit(child); }
      }
    };
    visit(value);
    return hashes;
  };
  keep('a');
  apply('correct', { entryId: 'a', text: 'end' });
  apply('share', { entryId: 'a', space: 'studio' });
  apply('allowCloud', { entryId: 'a' });
  keep('b');
  apply('forget', { entryId: 'a' });

  const beforeHashes = hashesIn(state);
  const aHashes = hashesIn(state.log.filter(record => record.entryId === 'a' || record.candidateId === 'a'));
  assert.ok(aHashes.size > 0, 'A must have recorded hashes before purge');
  for (const hash of aHashes) assert.ok(beforeHashes.has(hash));

  apply('purge', { now: '2040-02-01T00:00:00Z' });
  const afterHashes = hashesIn(state);
  assert.equal(read(state, { space: 'personal' }).find(entry => entry.id === 'b')?.text, 'middle');
  assert.deepEqual(state.trash, []);
  for (const text of ['middle', 'end']) {
    for (const encoded of [text, JSON.stringify(text)]) {
      const hash = createHash('sha256').update(encoded).digest('hex');
      assert.equal(afterHashes.has(hash), false, `Stored hash of purged text: ${encoded}`);
    }
  }
  for (const hash of aHashes) assert.equal(afterHashes.has(hash), false, `A's hash survived purge: ${hash}`);
});
