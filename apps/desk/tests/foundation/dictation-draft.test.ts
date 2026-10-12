import assert from 'node:assert/strict';
import test from 'node:test';
import { CapturedDictationDraft, type DictationDraftTarget } from '../../src/adapters/dictation-draft';
import { applyCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import type { DomainOptions } from '../../src/domain/types';

function fixture(text = 'Before selected after') {
  let id = 0;
  const options: DomainOptions = {
    id: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => '2026-10-09T12:00:00.000Z',
  };
  const initial = createDemoState(options);
  const sessionId = initial.sessions[0].id;
  const state = applyCommand(initial, { type: 'set-draft', sessionId, text }, options);
  const target: DictationDraftTarget = { connectionId: 'invented-connection', documentGeneration: 3,
    workspaceHandle: 'invented-native-handle', sessionId };
  const selection = { start: 7, end: 15 };
  const capture = () => new CapturedDictationDraft(state, target, selection);
  return { state, target, selection, options, capture };
}

test('final dictation replaces the captured selection as literal unsent text with an unconfirmed save', () => {
  const { state, target, selection, options, capture } = fixture();
  const before = structuredClone(state);
  const literal = ' <b>not markup</b>\nPress Enter to send?\n🙂 ';
  const result = capture().deliver(state, target, selection, 'delivery-one', literal, options);
  assert.equal(result.kind, 'applied-in-memory');
  if (result.kind !== 'applied-in-memory') return;
  assert.equal(result.persistence, 'unconfirmed');
  assert.equal(result.expectedRevision, state.revision);
  assert.equal(result.revision, state.revision + 1);
  assert.equal(result.state.drafts[target.sessionId], `Before ${literal} after`);
  assert.deepEqual(result.selection, { start: 7 + literal.length, end: 7 + literal.length });
  assert.deepEqual(result.state.messages, state.messages, 'No user or assistant message is created.');
  assert.deepEqual(result.state.activity, state.activity, 'No send or simulated response is recorded.');
  assert.deepEqual(result.state.selection, state.selection);
  assert.deepEqual(state, before, 'The original workspace is not mutated.');
});

test('caret insertion preserves Unicode and exact whitespace without trimming or appending extra characters', () => {
  const { state, target, options } = fixture('🙂 end');
  const selection = { start: 2, end: 2 };
  const binding = new CapturedDictationDraft(state, target, selection);
  const result = binding.deliver(state, target, selection, 'delivery', '\n  👋\t', options);
  assert.equal(result.kind, 'applied-in-memory');
  if (result.kind !== 'applied-in-memory') return;
  assert.equal(result.state.drafts[target.sessionId], '🙂\n  👋\t end');
  assert.equal(result.selection.start, '🙂\n  👋\t'.length);
});

test('editing the draft preserves newer work and consumes no second automatic insertion', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  const edited = applyCommand(state, { type: 'set-draft', sessionId: target.sessionId, text: 'A newer invented draft' }, options);
  const before = structuredClone(edited);
  assert.deepEqual(binding.deliver(edited, target, selection, 'one', 'Dictated', options), { kind: 'conflict', reason: 'draft-changed' });
  assert.deepEqual(edited, before);
  assert.deepEqual(binding.deliver(state, target, selection, 'one', 'Dictated', options),
    { kind: 'duplicate', persistence: 'unconfirmed', deliveryId: 'one', original: 'conflict' });
});

test('typing then restoring the old text is still a revision conflict', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  let edited = applyCommand(state, { type: 'set-draft', sessionId: target.sessionId, text: 'Intervening edit' }, options);
  edited = applyCommand(edited, { type: 'set-draft', sessionId: target.sessionId, text: state.drafts[target.sessionId] }, options);
  assert.deepEqual(binding.deliver(edited, target, selection, 'one', 'Dictated', options), { kind: 'conflict', reason: 'workspace-changed' });
});

test('unrelated workspace edits conservatively conflict until a per-draft revision contract exists', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  const edited = applyCommand(state, { type: 'add-note', goalId: state.goals[0].id, body: 'Unrelated invented note' }, options);
  assert.deepEqual(binding.deliver(edited, target, selection, 'one', 'Dictated', options), { kind: 'conflict', reason: 'workspace-changed' });
});

test('changing the selected session cannot redirect dictation to either draft', () => {
  const { state, target, selection, options } = fixture();
  const withOther = applyCommand(state, { type: 'create-session', goalId: state.goals[0].id }, options);
  const otherId = withOther.selection.sessionId!;
  const origin = applyCommand(withOther, { type: 'select-session', sessionId: target.sessionId }, options);
  const binding = new CapturedDictationDraft(origin, target, selection);
  const switched = applyCommand(origin, { type: 'select-session', sessionId: otherId }, options);
  assert.equal(switched.revision, origin.revision, 'Navigation does not change the workspace revision.');
  const before = structuredClone(switched);
  assert.deepEqual(binding.deliver(switched, { ...target, sessionId: otherId }, selection, 'one', 'Dictated', options), { kind: 'conflict', reason: 'target-changed' });
  assert.deepEqual(switched, before);
  assert.equal(switched.drafts[otherId], '');
});

test('a stale caller target cannot hide a change in the state-selected session', () => {
  const { state, target, selection, options } = fixture();
  const withOther = applyCommand(state, { type: 'create-session', goalId: state.goals[0].id }, options);
  const origin = applyCommand(withOther, { type: 'select-session', sessionId: target.sessionId }, options);
  const binding = new CapturedDictationDraft(origin, target, selection);
  assert.deepEqual(binding.deliver(withOther, target, selection, 'one', 'Dictated', options), { kind: 'conflict', reason: 'target-changed' });
});

test('workspace, document and connection changes refuse the original target', () => {
  const { state, target, selection, options, capture } = fixture();
  for (const change of [{ workspaceHandle: 'different-workspace' }, { documentGeneration: 4 }, { connectionId: 'different-connection' }]) {
    assert.deepEqual(capture().deliver(state, { ...target, ...change }, selection, 'one', 'Dictated', options), { kind: 'conflict', reason: 'target-changed' });
  }
});

test('moving the selection during recording refuses implicit insertion at either old or new caret', () => {
  const { state, target, options, capture } = fixture();
  const before = structuredClone(state);
  assert.deepEqual(capture().deliver(state, target, { start: 0, end: 0 }, 'one', 'Dictated', options), { kind: 'conflict', reason: 'selection-changed' });
  assert.deepEqual(state, before);
});

test('a duplicate final delivery never returns another candidate or claims persistence', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  const first = binding.deliver(state, target, selection, 'one', 'Dictated', options);
  assert.equal(first.kind, 'applied-in-memory');
  if (first.kind !== 'applied-in-memory') return;
  const duplicate = binding.deliver(first.state, target, first.selection, 'one', 'Dictated', options);
  assert.deepEqual(duplicate, { kind: 'duplicate', persistence: 'unconfirmed', deliveryId: 'one', original: 'applied-in-memory' });
  assert.equal('state' in duplicate, false);
  assert.equal(first.state.drafts[target.sessionId], 'Before Dictated after');
});

test('changed text under the same delivery ID and a second final ID are refused', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  binding.deliver(state, target, selection, 'one', 'Dictated', options);
  assert.deepEqual(binding.deliver(state, target, selection, 'one', 'Changed text', options), { kind: 'refused', reason: 'identity-reused' });
  assert.deepEqual(binding.deliver(state, target, selection, 'two', 'Dictated', options), { kind: 'refused', reason: 'already-delivered' });
});

test('capture copies target and selection rather than following later object mutations', () => {
  const { state, target, selection, options, capture } = fixture();
  const originalTarget = { ...target };
  const originalSelection = { ...selection };
  const binding = capture();
  const mutableTarget: { workspaceHandle: string } = target;
  mutableTarget.workspaceHandle = 'changed';
  selection.start = 0;
  const result = binding.deliver(state, originalTarget, originalSelection, 'one', 'Dictated', options);
  assert.equal(result.kind, 'applied-in-memory');
});

test('explicit invalidation refuses even if a user returns to the original session and draft', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  binding.invalidate();
  binding.invalidate();
  assert.deepEqual(binding.deliver(state, target, selection, 'one', 'Dictated', options), { kind: 'refused', reason: 'revoked' });
});

test('lock or navigation invalidation prevents a previously accepted delivery from exposing a cached outcome', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  binding.deliver(state, target, selection, 'one', 'Dictated', options);
  binding.invalidate();
  assert.deepEqual(binding.deliver(state, target, selection, 'one', 'Dictated', options), { kind: 'refused', reason: 'revoked' });
});

test('empty final text cannot delete the captured selection', () => {
  const { state, target, selection, options, capture } = fixture();
  const binding = capture();
  const before = structuredClone(state);
  assert.deepEqual(binding.deliver(state, target, selection, 'one', '', options), { kind: 'refused', reason: 'invalid-delivery' });
  assert.deepEqual(state, before);
  assert.equal(binding.deliver(state, target, selection, 'one', ' ', options).kind, 'applied-in-memory', 'Literal whitespace is not trimmed.');
});

test('invalid ranges and half-surrogate boundaries cannot be captured', () => {
  const { state, target } = fixture('🙂 end');
  for (const selection of [{ start: -1, end: 0 }, { start: 3, end: 2 }, { start: 0, end: 99 }, { start: 1, end: 1 }, { start: 0, end: 1 }, { start: 0.5, end: 2 }]) {
    assert.throws(() => new CapturedDictationDraft(state, target, selection), TypeError);
  }
});

test('capture refuses absent or inactive sessions and unsafe revisions', () => {
  const { state, target, selection } = fixture();
  assert.throws(() => new CapturedDictationDraft(state, { ...target, sessionId: 'missing' }, selection), TypeError);
  assert.throws(() => new CapturedDictationDraft({ ...state, selection: { ...state.selection, sessionId: null } }, target, selection), TypeError);
  for (const revision of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new CapturedDictationDraft({ ...state, revision }, target, selection), TypeError);
  }
});

test('invalidation during command application cannot expose a late candidate', () => {
  const { state, target, selection, options, capture } = fixture();
  const before = structuredClone(state);
  const binding = capture();
  const result = binding.deliver(state, target, selection, 'one', 'Dictated', {
    ...options,
    now: () => { binding.invalidate(); return '2026-10-09T12:00:00.000Z'; },
  });
  assert.deepEqual(result, { kind: 'refused', reason: 'revoked' });
  assert.deepEqual(state, before);
});
