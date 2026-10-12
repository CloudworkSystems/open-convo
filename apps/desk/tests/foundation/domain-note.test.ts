import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository, DESK_STORAGE_KEY, type StorageLike } from '../../src/adapters/browser-repository';
import { applyCommand, DomainError } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { validateState } from '../../src/domain/validation';

class NoteStorage implements StorageLike {
  raw: string | null = null;
  blocked = false;
  getItem(key: string) { return key === DESK_STORAGE_KEY ? this.raw : null; }
  setItem(key: string, value: string) {
    if (this.blocked) throw new Error('Blocked write');
    assert.equal(key, DESK_STORAGE_KEY);
    this.raw = value;
  }
}

test('earlier schema-version-1 workspaces remain byte-for-byte unchanged without domain notes', () => {
  const state = createDemoState();
  const original = JSON.stringify(state);
  assert.equal(Object.hasOwn(state.goals[0], 'purpose'), false);
  assert.equal(Object.hasOwn(state.goalDrafts[state.goals[0].id], 'purpose'), false);
  const result = validateState(JSON.parse(original));
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(JSON.stringify(result.state), original);
});

test('a domain note stores grouping intent without changing sessions, messages, work, hierarchy or other drafts', () => {
  const original = createDemoState();
  let state = applyCommand(original, { type: 'create-goal', title: 'Invented research', parentId: original.goals[0].id });
  const goalId = state.selection.goalId!;
  const sessionId = state.selection.sessionId!;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Preserve an invented message draft' });
  state = applyCommand(state, { type: 'send-demo', sessionId });
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Preserve the follow-up too' });
  state = applyCommand(state, { type: 'add-work', goalId, title: 'Invented related work' });
  state = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'nextStep', value: 'Preserve this next-step draft' });
  state = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'purpose', value: '  Research about trees 🌳\nInclude related ideas.  ' });
  const before = JSON.stringify(state);
  const saved = applyCommand(state, { type: 'edit-domain-note', goalId, purpose: state.goalDrafts[goalId].purpose!, expectedPurpose: '' });
  assert.equal(saved.goals.find((goal) => goal.id === goalId)?.purpose, 'Research about trees 🌳\nInclude related ideas.');
  assert.equal(saved.goals.find((goal) => goal.id === goalId)?.parentId, original.goals[0].id);
  assert.deepEqual(saved.sessions, state.sessions);
  assert.deepEqual(saved.messages, state.messages);
  assert.deepEqual(saved.drafts, state.drafts);
  assert.deepEqual(saved.workItems, state.workItems);
  assert.deepEqual(saved.notes, state.notes);
  assert.deepEqual(saved.selection, state.selection);
  assert.deepEqual(saved.preferences, state.preferences);
  assert.equal(saved.goalDrafts[goalId].nextStep, state.goalDrafts[goalId].nextStep);
  assert.equal(Object.hasOwn(saved.goalDrafts[goalId], 'purpose'), false);
  assert.equal(saved.revision, state.revision + 1);
  assert.equal(saved.activity.at(-1)?.summary, 'Domain note saved.');
  assert.equal(validateState(saved).valid, true);
  assert.equal(JSON.stringify(state), before);
});

test('unfinished note forms survive domain switches, navigation and repository reload; a failed save retains attempted text', async () => {
  const storage = new NoteStorage();
  const repository = new BrowserRepository(storage, async (operation) => operation());
  let state = createDemoState();
  assert.equal((await repository.save(state, null)).kind, 'saved');
  const goalId = state.goals[0].id;
  const originalRevision = state.revision;
  state = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'purpose', value: 'Keep this unfinished invented note.' });
  state = applyCommand(state, { type: 'create-goal', title: 'Second invented domain', empty: true });
  state = applyCommand(state, { type: 'navigate', route: 'work' });
  assert.equal((await repository.save(state, originalRevision)).kind, 'saved');
  const reloaded = repository.load();
  assert.equal(reloaded.kind, 'ready');
  if (reloaded.kind === 'ready') assert.equal(reloaded.state.goalDrafts[goalId].purpose, 'Keep this unfinished invented note.');
  const savedRaw = storage.raw;
  const failedAttempt = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'purpose', value: 'Also retain the blocked save attempt.' });
  storage.blocked = true;
  const result = await repository.save(failedAttempt, state.revision);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.attemptedState.goalDrafts[goalId].purpose, 'Also retain the blocked save attempt.');
  assert.equal(storage.raw, savedRaw);
});

test('cancel discards only the note draft; blank Save removes only the optional saved note', () => {
  let state = createDemoState();
  const goalId = state.goals[0].id;
  state = applyCommand(state, { type: 'edit-domain-note', goalId, purpose: 'Preserve the original concept' });
  state = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'purpose', value: 'Do not commit this alternate concept' });
  const cancelled = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'purpose', value: null });
  assert.equal(cancelled.goals[0].purpose, 'Preserve the original concept');
  assert.equal(Object.hasOwn(cancelled.goalDrafts[goalId], 'purpose'), false);
  assert.deepEqual(cancelled.sessions, state.sessions);
  assert.equal(applyCommand(cancelled, { type: 'set-goal-draft', goalId, field: 'purpose', value: null }), cancelled);
  const cleared = applyCommand(cancelled, { type: 'edit-domain-note', goalId, purpose: ' \n ' });
  assert.equal(Object.hasOwn(cleared.goals[0], 'purpose'), false);
  assert.equal(cleared.goals[0].nextStep, state.goals[0].nextStep);
  assert.deepEqual(cleared.sessions, state.sessions);
  assert.equal(cleared.activity.at(-1)?.summary, 'Domain note cleared.');
  assert.equal(validateState(cleared).valid, true);
});

test('unchanged note saves are no-ops; unchanged text with a pending draft still closes that form', () => {
  let state = createDemoState();
  const goalId = state.goals[0].id;
  assert.equal(applyCommand(state, { type: 'edit-domain-note', goalId, purpose: '' }), state);
  state = applyCommand(state, { type: 'edit-domain-note', goalId, purpose: 'Invented grouping intent' });
  assert.equal(applyCommand(state, { type: 'edit-domain-note', goalId, purpose: ' Invented grouping intent \n' }), state);
  const drafting = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'purpose', value: 'Invented grouping intent' });
  const saved = applyCommand(drafting, { type: 'edit-domain-note', goalId, purpose: 'Invented grouping intent' });
  assert.equal(Object.hasOwn(saved.goalDrafts[goalId], 'purpose'), false);
  assert.equal(saved.revision, drafting.revision + 1);
});

test('stale saves, oversized notes, invalid fields and absent domains are refused without changing work', () => {
  const state = createDemoState();
  const goalId = state.goals[0].id;
  const before = JSON.stringify(state);
  for (const command of [
    { type: 'edit-domain-note', goalId, purpose: 'Attempted stale edit', expectedPurpose: 'A different concept' },
    { type: 'edit-domain-note', goalId, purpose: 'x'.repeat(4001) },
    { type: 'set-goal-draft', goalId, field: 'purpose', value: 'x'.repeat(4001) },
    { type: 'edit-domain-note', goalId: '00000000-0000-4000-8000-999999999999', purpose: 'Missing domain' },
  ] as const) {
    assert.throws(() => applyCommand(state, command), DomainError);
    assert.equal(JSON.stringify(state), before);
  }
  const boundary = applyCommand(state, { type: 'edit-domain-note', goalId, purpose: 'x'.repeat(4000) });
  assert.equal(validateState(boundary).valid, true);
  for (const purpose of [3, null, {}, 'x'.repeat(4001)]) {
    const malformed = { ...state, goals: [{ ...state.goals[0], purpose }] };
    assert.equal(validateState(malformed).valid, false);
  }
  const malformedDraft = { ...state, goalDrafts: { [goalId]: { ...state.goalDrafts[goalId], purpose: 3 } } };
  assert.equal(validateState(malformedDraft).valid, false);
});
