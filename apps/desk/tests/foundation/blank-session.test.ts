import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, DomainError, isViewCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { validateState } from '../../src/domain/validation';
import { DESK_NATIVE_OPENED_NAME, nativeOpenedBefore } from '../../src/adapters/fresh-open';

const time = '2026-11-02T12:00:00.000Z';
const later = '2026-11-02T12:05:00.000Z';

test('a blank session is only a view: it saves nothing and adds no session row', () => {
  const state = createDemoState({ now: () => time });
  const goalId = state.goals[0].id;
  for (const target of [goalId, null]) {
    const command = { type: 'open-blank-session', goalId: target } as const;
    assert.equal(isViewCommand(command), true);
    const blank = applyCommand(state, command, { now: () => later });
    assert.deepEqual(blank.selection, { goalId: target, sessionId: null, route: 'sessions' });
    assert.equal(blank.preferences.nexusView, 'navigator');
    assert.equal(blank.revision, state.revision);
    assert.equal(blank.updatedAt, state.updatedAt);
    assert.deepEqual(blank.sessions, state.sessions);
    assert.deepEqual(blank.drafts, state.drafts);
    assert.deepEqual(blank.activity, state.activity);
    assert.equal(validateState(blank).valid, true);
  }
  assert.throws(() => applyCommand(state, { type: 'open-blank-session', goalId: '00000000-0000-4000-8000-999999999999' }), DomainError);
});

test('typing into a blank session saves it with that first text as its draft', () => {
  const state = createDemoState({ now: () => time });
  const goalId = state.goals[0].id;
  const blank = applyCommand(state, { type: 'open-blank-session', goalId });
  const started = applyCommand(blank, { type: 'create-session', goalId, draft: 'H' }, { now: () => later });
  const session = started.sessions.at(-1)!;
  assert.equal(started.sessions.length, state.sessions.length + 1);
  assert.equal(session.goalId, goalId);
  assert.equal(started.drafts[session.id], 'H');
  assert.deepEqual(started.selection, { goalId, sessionId: session.id, route: 'sessions' });
  assert.equal(started.revision, state.revision + 1);
  assert.equal(validateState(started).valid, true);
  // Without a first text, create-session keeps its old empty draft.
  const plain = applyCommand(state, { type: 'create-session', goalId: null });
  assert.equal(plain.drafts[plain.sessions.at(-1)!.id], '');
});

test('a Mac window opens blank the first time and keeps its screen on reload', () => {
  const navigation = (type: string) => ({ getEntriesByType: (kind: string) => kind === 'navigation' ? [{ type }] : [] });
  const fresh = { name: '', performance: navigation('navigate') };
  assert.equal(nativeOpenedBefore(fresh), false, 'a new window opens blank');
  assert.equal(fresh.name, DESK_NATIVE_OPENED_NAME);
  assert.equal(nativeOpenedBefore(fresh), true, 'the same window loaded again keeps its screen');
  assert.equal(nativeOpenedBefore({ name: '', performance: navigation('reload') }), true,
    'a reload keeps its screen even when the name did not survive (a crashed web process)');
  assert.equal(nativeOpenedBefore({ name: '' }), false, 'no navigation timing: treat as new');
  const throwing = { name: '', performance: { getEntriesByType: () => { throw new Error('unavailable'); } } };
  assert.equal(nativeOpenedBefore(throwing), false);
});
