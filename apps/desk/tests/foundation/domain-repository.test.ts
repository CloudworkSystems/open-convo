import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository, DESK_STORAGE_KEY, type LockRunner, type StorageLike } from '../../src/adapters/browser-repository';
import { applyCommand, DomainError, isViewCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import type { DeskCommand, DomainOptions } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  writes = 0;
  reads: string[] = [];
  failWrites = false;
  failReads = false;

  getItem(key: string): string | null {
    this.reads.push(key);
    if (this.failReads) throw new Error('Blocked read');
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('Quota exceeded');
    this.writes += 1;
    this.data.set(key, value);
  }
}

function serializedLock(): LockRunner {
  let previous: Promise<void> = Promise.resolve();
  return async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const waitFor = previous;
    let release!: () => void;
    previous = new Promise<void>((resolve) => { release = resolve; });
    await waitFor;
    try { return await operation(); } finally { release(); }
  };
}

function fixture() {
  let nextId = 0;
  const options: DomainOptions = {
    id: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => '2026-10-03T16:30:00.000Z',
  };
  const state = createDemoState(options);
  const storage = new MemoryStorage();
  const repository = new BrowserRepository(storage, serializedLock());
  return { state, storage, repository, options };
}

test('tab navigation and appearance change the view without advancing shared content or invalidating its next save', async () => {
  const { state, storage, repository, options } = fixture();
  const firstGoal = state.selection.goalId!;
  let content = applyCommand(state, { type: 'create-goal', title: 'Another invented goal' }, options);
  const otherSession = content.selection.sessionId!;
  content = applyCommand(content, { type: 'create-session', goalId: firstGoal }, options);
  await repository.save(content, null);
  const originalRevision = content.revision;
  const originalTimestamp = content.updatedAt;
  const commands: DeskCommand[] = [
    { type: 'select-goal', goalId: firstGoal },
    { type: 'select-session', sessionId: otherSession },
    { type: 'navigate', route: 'memory' },
    { type: 'set-theme', theme: 'dark' },
  ];
  let viewed = content;
  for (const command of commands) {
    assert.equal(isViewCommand(command), true);
    viewed = applyCommand(viewed, command, { ...options, now: () => '2027-10-03T16:30:00.000Z' });
    assert.equal(viewed.revision, originalRevision);
    assert.equal(viewed.updatedAt, originalTimestamp);
    assert.deepEqual(viewed.activity, content.activity);
  }
  assert.equal(viewed.selection.sessionId!, otherSession);
  assert.equal(viewed.selection.route, 'memory');
  assert.equal(viewed.preferences.theme, 'dark');
  assert.equal(storage.writes, 1);
  assert.equal(repository.load().kind, 'ready');
  const edit: DeskCommand = { type: 'set-draft', sessionId: otherSession, text: 'Invented draft after changing this tab view' };
  assert.equal(isViewCommand(edit), false);
  const edited = applyCommand(viewed, edit, options);
  assert.equal(edited.revision, originalRevision + 1);
  assert.equal((await repository.save(edited, originalRevision)).kind, 'saved');
});

test('a backward device clock cannot invalidate draft or next-step saves or reverse stored timestamps', async () => {
  const { state, repository, options } = fixture();
  await repository.save(state, null);
  const forward = { ...options, now: () => '2027-10-03T16:30:00.000Z' };
  const rollback = { ...options, now: () => '2025-10-03T16:30:00.000Z' };
  const sessionId = state.selection.sessionId!;
  const goalId = state.selection.goalId!;
  let edited = applyCommand(state, { type: 'set-draft', sessionId, text: 'Invented work before the clock changes' }, forward);
  assert.equal((await repository.save(edited, state.revision)).kind, 'saved');
  const revision = edited.revision;
  edited = applyCommand(edited, { type: 'set-draft', sessionId, text: 'Invented work after the clock rolls back' }, rollback);
  edited = applyCommand(edited, { type: 'edit-next-step', goalId, nextStep: 'Keep the next step editable after clock rollback' }, rollback);
  assert.equal(edited.updatedAt, '2027-10-03T16:30:00.000Z');
  assert.equal(edited.sessions[0].updatedAt, '2027-10-03T16:30:00.000Z');
  assert.equal(edited.goals[0].updatedAt, '2027-10-03T16:30:00.000Z');
  assert.equal(edited.activity.at(-1)!.createdAt, '2027-10-03T16:30:00.000Z');
  assert.equal(edited.revision, revision + 2);
  assert.equal(validateState(edited).valid, true);
  assert.equal((await repository.save(edited, revision)).kind, 'saved');
  const reopened = repository.load();
  assert.equal(reopened.kind, 'ready');
  if (reopened.kind !== 'ready') return;
  assert.equal(reopened.state.drafts[sessionId], 'Invented work after the clock rolls back');
  assert.equal(reopened.state.goals[0].nextStep, 'Keep the next step editable after clock rollback');
});

test('record timestamps newer than the workspace timestamp remain valid on an edit with an older clock', () => {
  const { state, options } = fixture();
  const future = structuredClone(state);
  future.goals[0].createdAt = '2028-10-03T16:30:00.000Z';
  future.goals[0].updatedAt = '2029-10-03T16:30:00.000Z';
  future.sessions[0].createdAt = '2028-10-03T16:30:00.000Z';
  future.sessions[0].updatedAt = '2029-10-03T16:30:00.000Z';
  assert.equal(validateState(future).valid, true);
  let edited = applyCommand(future, { type: 'set-draft', sessionId: future.selection.sessionId!, text: 'Invented edit despite an older device clock' }, options);
  edited = applyCommand(edited, { type: 'edit-next-step', goalId: future.selection.goalId!, nextStep: 'Preserve record timestamp integrity' }, options);
  assert.equal(edited.updatedAt, '2029-10-03T16:30:00.000Z');
  assert.equal(validateState(edited).valid, true);
});

test('reload retains long drafts, next steps, selection and exact canonical timestamps', async () => {
  const { state, storage, repository, options } = fixture();
  assert.equal((await repository.save(state, null)).kind, 'saved');
  const goalId = state.selection.goalId!;
  const sessionId = state.selection.sessionId!;
  const longDraft = `Invented draft\n${'α useful detail '.repeat(900)}\nFinish intact.`;
  let edited = applyCommand(state, { type: 'set-draft', sessionId, text: longDraft }, options);
  edited = applyCommand(edited, { type: 'edit-next-step', goalId, nextStep: 'Try a worksheet with an invented reader.' }, options);
  edited = applyCommand(edited, { type: 'navigate', route: 'work' }, options);
  assert.equal((await repository.save(edited, state.revision)).kind, 'saved');
  const reopened = new BrowserRepository(storage, serializedLock()).load();
  assert.equal(reopened.kind, 'ready');
  if (reopened.kind !== 'ready') return;
  assert.equal(reopened.state.drafts[sessionId], longDraft);
  assert.equal(reopened.state.goals[0].nextStep, 'Try a worksheet with an invented reader.');
  assert.equal(reopened.state.selection.route, 'work');
  assert.equal(reopened.state.updatedAt, '2026-10-03T16:30:00.000Z');
});

test('sending after selecting another session stays bound to the originating draft and goal', () => {
  const { state, options } = fixture();
  const originalSession = state.selection.sessionId!;
  let edited = applyCommand(state, { type: 'set-draft', sessionId: originalSession, text: 'Invented first-session idea' }, options);
  edited = applyCommand(edited, { type: 'create-goal', title: 'A different goal' }, options);
  const otherSession = edited.selection.sessionId!;
  edited = applyCommand(edited, { type: 'set-draft', sessionId: otherSession, text: 'Keep this other draft' }, options);
  const result = applyCommand(edited, { type: 'send-demo', sessionId: originalSession, expectedDraft: 'Invented first-session idea' }, options);
  assert.equal(result.selection.sessionId!, otherSession);
  assert.equal(result.drafts[otherSession], 'Keep this other draft');
  assert.equal(result.drafts[originalSession], '');
  const added = result.messages.slice(state.messages.length);
  assert.equal(added.length, 2);
  assert.ok(added.every((message) => message.sessionId === originalSession && message.provenance === 'simulation'));
  assert.deepEqual(added.map((message) => message.role), ['user', 'assistant']);
  assert.ok(added[1].body.includes('Shape a useful idea'));
  assert.ok(!added[1].body.includes('A different goal'));
  assert.equal(validateState(result).valid, true);
});

test('stale draft submission and stale next-step edits refuse to discard current work', () => {
  const { state, options } = fixture();
  const sessionId = state.selection.sessionId!;
  const changed = applyCommand(state, { type: 'set-draft', sessionId, text: 'A newer invented draft' }, options);
  assert.throws(() => applyCommand(changed, { type: 'send-demo', sessionId, expectedDraft: 'An older draft' }, options), DomainError);
  assert.throws(() => applyCommand(changed, { type: 'set-draft', sessionId, text: 'Overwriting edit', expectedText: 'An older draft' }, options), DomainError);
  assert.throws(() => applyCommand(changed, { type: 'edit-next-step', goalId: state.selection.goalId!, nextStep: 'Overwriting step', expectedNextStep: 'An older step' }, options), DomainError);
  assert.equal(changed.drafts[sessionId], 'A newer invented draft');
  assert.equal(changed.messages.length, state.messages.length);
  assert.equal(changed.goals[0].nextStep, state.goals[0].nextStep);
});

test('unchanged goal forms do not advance a revision while actual drafts still save and clear', () => {
  const { state, options } = fixture();
  const goalId = state.selection.goalId!;
  const unchanged: DeskCommand[] = [
    { type: 'set-goal-draft', goalId, field: 'nextStep', value: null },
    { type: 'set-goal-draft', goalId, field: 'workTitle', value: '' },
    { type: 'edit-next-step', goalId, nextStep: state.goals[0].nextStep },
  ];
  for (const command of unchanged) {
    assert.equal(applyCommand(state, command, options), state);
  }
  const changed = applyCommand(state, {
    type: 'set-goal-draft', goalId, field: 'nextStep', value: 'A genuinely edited next-step draft',
  }, options);
  assert.equal(changed.revision, state.revision + 1);
  assert.equal(applyCommand(changed, {
    type: 'set-goal-draft', goalId, field: 'nextStep', value: 'A genuinely edited next-step draft',
  }, options), changed);
  const cancelled = applyCommand(changed, { type: 'set-goal-draft', goalId, field: 'nextStep', value: null }, options);
  assert.equal(cancelled.revision, changed.revision + 1);
  assert.equal(cancelled.goalDrafts[goalId].nextStep, null);
  assert.equal(applyCommand(cancelled, { type: 'set-goal-draft', goalId, field: 'nextStep', value: null }, options), cancelled);
  // Saving an unchanged committed value still clears a real pending draft.
  const committed = applyCommand(changed, { type: 'edit-next-step', goalId, nextStep: state.goals[0].nextStep }, options);
  assert.equal(committed.revision, changed.revision + 1);
  assert.equal(committed.goalDrafts[goalId].nextStep, null);
});

test('pending goal forms survive goal switches, routes and reload independently', async () => {
  const { state, repository, storage, options } = fixture();
  await repository.save(state, null);
  const firstGoal = state.selection.goalId!;
  let edited = applyCommand(state, { type: 'set-goal-draft', goalId: firstGoal, field: 'nextStep', value: 'Pending invented first-goal step' }, options);
  edited = applyCommand(edited, { type: 'set-goal-draft', goalId: firstGoal, field: 'workTitle', value: 'Pending invented first-goal work' }, options);
  edited = applyCommand(edited, { type: 'create-goal', title: 'Another invented goal' }, options);
  const secondGoal = edited.selection.goalId!;
  assert.deepEqual(edited.goalDrafts[secondGoal], { nextStep: null, workTitle: '' });
  edited = applyCommand(edited, { type: 'set-goal-draft', goalId: secondGoal, field: 'workTitle', value: 'Keep second-goal work separate' }, options);
  edited = applyCommand(edited, { type: 'navigate', route: 'work' }, options);
  edited = applyCommand(edited, { type: 'select-goal', goalId: firstGoal }, options);
  assert.equal((await repository.save(edited, 0)).kind, 'saved');
  const reopened = new BrowserRepository(storage, serializedLock()).load();
  assert.equal(reopened.kind, 'ready');
  if (reopened.kind !== 'ready') return;
  assert.deepEqual(reopened.state.goalDrafts[firstGoal], { nextStep: 'Pending invented first-goal step', workTitle: 'Pending invented first-goal work' });
  assert.equal(reopened.state.goalDrafts[secondGoal].workTitle, 'Keep second-goal work separate');
  assert.equal(reopened.state.goals[0].nextStep, state.goals[0].nextStep);
  assert.equal(reopened.state.selection.route, 'work');
});

test('submitting a goal form after selection changes writes only its explicit origin and clears only that draft', () => {
  const { state, options } = fixture();
  const firstGoal = state.selection.goalId!;
  let edited = applyCommand(state, { type: 'set-goal-draft', goalId: firstGoal, field: 'workTitle', value: 'First-goal planned work' }, options);
  edited = applyCommand(edited, { type: 'set-goal-draft', goalId: firstGoal, field: 'nextStep', value: 'First-goal committed step' }, options);
  edited = applyCommand(edited, { type: 'create-goal', title: 'Second invented goal' }, options);
  const secondGoal = edited.selection.goalId!;
  edited = applyCommand(edited, { type: 'set-goal-draft', goalId: secondGoal, field: 'workTitle', value: 'Second-goal pending work' }, options);
  edited = applyCommand(edited, { type: 'set-goal-draft', goalId: secondGoal, field: 'nextStep', value: 'Second-goal pending step' }, options);
  edited = applyCommand(edited, { type: 'add-work', goalId: firstGoal, title: edited.goalDrafts[firstGoal].workTitle }, options);
  edited = applyCommand(edited, { type: 'edit-next-step', goalId: firstGoal, nextStep: edited.goalDrafts[firstGoal].nextStep! }, options);
  assert.equal(edited.selection.goalId!, secondGoal);
  assert.equal(edited.workItems.at(-1)!.goalId, firstGoal);
  assert.equal(edited.workItems.at(-1)!.title, 'First-goal planned work');
  assert.equal(edited.goals[0].nextStep, 'First-goal committed step');
  assert.deepEqual(edited.goalDrafts[firstGoal], { nextStep: null, workTitle: '' });
  assert.deepEqual(edited.goalDrafts[secondGoal], { nextStep: 'Second-goal pending step', workTitle: 'Second-goal pending work' });
  assert.equal(validateState(edited).valid, true);
});

test('unsupported versions of an otherwise valid schema-2 workspace retain the version-specific refusal and original storage', async () => {
  const { state, storage, repository } = fixture();
  const supported = { ...state, schemaVersion: 2, conversationRuns: [],
    capabilities: { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' } };
  assert.equal(validateState(supported).valid, true, 'The version must be the only invalid field.');
  const candidate = { ...supported, schemaVersion: 999 };
  const expected = 'This synthetic workspace version is unsupported. Its contents were kept.';
  assert.deepEqual(validateState(candidate), { valid: false, error: expected });
  const raw = JSON.stringify(candidate);
  storage.data.set(DESK_STORAGE_KEY, raw);
  assert.deepEqual(repository.load(), { kind: 'invalid', error: expected, raw });
  const result = await repository.save(state, null);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.error, `Save refused: ${expected}`);
  assert.equal(storage.data.get(DESK_STORAGE_KEY), raw);
  assert.equal(storage.writes, 0);
});

test('invalid identities, dangling links and capabilities are refused without repairing storage', async () => {
  const { state, storage, repository } = fixture();
  const cases: unknown[] = [
    { ...state, sessions: [{ ...state.sessions[0], goalId: '00000000-0000-4000-8000-999999999999' }] },
    { ...state, messages: [{ ...state.messages[0], id: state.goals[0].id }] },
    { ...state, drafts: {} },
    { ...state, goalDrafts: {} },
    { ...state, goalDrafts: { [state.selection.goalId!]: { nextStep: null, workTitle: null } } },
    { ...state, updatedAt: '2026-10-03T12:30:00-04:00' },
    { ...state, capabilities: { ...state.capabilities, provider: 'connected' } },
    { ...state, apiKey: 'invented-canary' },
  ];
  for (const candidate of cases) {
    const raw = JSON.stringify(candidate);
    storage.data.set(DESK_STORAGE_KEY, raw);
    assert.equal(repository.load().kind, 'invalid');
    assert.equal((await repository.save(state, null)).kind, 'failed');
    assert.equal(storage.data.get(DESK_STORAGE_KEY), raw);
  }
  assert.equal(storage.writes, 0);
});

test('malformed JSON is retained, reported and never silently initialized', async () => {
  const { state, storage, repository } = fixture();
  const raw = '{broken invented data';
  storage.data.set(DESK_STORAGE_KEY, raw);
  const result = repository.load();
  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') assert.equal(result.raw, raw);
  assert.equal((await repository.save(state, null)).kind, 'failed');
  assert.equal(storage.data.get(DESK_STORAGE_KEY), raw);
  assert.equal(storage.writes, 0);
});

test('quota failure keeps prior saved state and the complete attempt for explicit retry', async () => {
  const { state, storage, repository, options } = fixture();
  await repository.save(state, null);
  const before = storage.data.get(DESK_STORAGE_KEY);
  const attempted = applyCommand(state, { type: 'set-draft', sessionId: state.selection.sessionId!, text: 'Invented work that must survive a failed save' }, options);
  storage.failWrites = true;
  const result = await repository.save(attempted, state.revision);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.deepEqual(result.attemptedState, attempted);
  assert.equal(storage.data.get(DESK_STORAGE_KEY), before);
  assert.equal(state.drafts[state.selection.sessionId!], '');
  storage.failWrites = false;
  assert.equal((await repository.save(attempted, state.revision)).kind, 'saved');
});

test('two writers serialize revision checks, retaining the losing attempt without overwriting the winner', async () => {
  const { state, storage, options } = fixture();
  const lock = serializedLock();
  const first = new BrowserRepository(storage, lock);
  const second = new BrowserRepository(storage, lock);
  await first.save(state, null);
  const a = applyCommand(state, { type: 'set-draft', sessionId: state.selection.sessionId!, text: 'First tab invented draft' }, options);
  const b = applyCommand(state, { type: 'set-draft', sessionId: state.selection.sessionId!, text: 'Second tab invented draft' }, options);
  const [winner, loser] = await Promise.all([first.save(a, 0), second.save(b, 0)]);
  assert.equal(winner.kind, 'saved');
  assert.equal(loser.kind, 'conflict');
  if (loser.kind === 'conflict') {
    assert.deepEqual(loser.attemptedState, b);
    assert.deepEqual(loser.currentState, a);
  }
  assert.deepEqual(JSON.parse(storage.data.get(DESK_STORAGE_KEY)!), a);
  assert.equal(storage.writes, 2);
});

test('after an initial save fails, explicit retry may save all newer in-memory edits into the still-empty store', async () => {
  const { state, storage, repository, options } = fixture();
  storage.failWrites = true;
  assert.equal((await repository.save(state, null)).kind, 'failed');
  let edited = applyCommand(state, { type: 'set-draft', sessionId: state.selection.sessionId!, text: 'Keep invented draft after first save failed' }, options);
  edited = applyCommand(edited, { type: 'edit-next-step', goalId: state.selection.goalId!, nextStep: 'Preserve the newer invented step too' }, options);
  storage.failWrites = false;
  assert.equal((await repository.save(edited, null)).kind, 'saved');
  assert.deepEqual(repository.load(), { kind: 'ready', state: edited });
});

test('a removed established store is a conflict, not permission to bootstrap over lost work', async () => {
  const { state, storage, repository, options } = fixture();
  await repository.save(state, null);
  storage.data.delete(DESK_STORAGE_KEY);
  const edited = applyCommand(state, { type: 'set-draft', sessionId: state.selection.sessionId!, text: 'Retain after missing store' }, options);
  const result = await repository.save(edited, 0);
  assert.equal(result.kind, 'conflict');
  assert.equal(storage.data.has(DESK_STORAGE_KEY), false);
});

test('read or lock failures make no saved claim and do not lose the attempted state', async () => {
  const { state, storage } = fixture();
  storage.failReads = true;
  const blockedRead = new BrowserRepository(storage, serializedLock());
  assert.equal(blockedRead.load().kind, 'unavailable');
  const unreadable = await blockedRead.save(state, null);
  assert.equal(unreadable.kind, 'failed');
  if (unreadable.kind === 'failed') assert.deepEqual(unreadable.attemptedState, state);
  const brokenLock: LockRunner = async () => { throw new Error('Cannot obtain lock'); };
  const unlocked = await new BrowserRepository(storage, brokenLock).save(state, null);
  assert.equal(unlocked.kind, 'failed');
  assert.equal(storage.writes, 0);
});

test('missing browser write coordination refuses a save instead of permitting unsafe tab overwrites', async () => {
  const { state, storage } = fixture();
  const repository = new BrowserRepository(storage);
  const result = await repository.save(state, null);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.match(result.error, /read-only/);
  assert.equal(storage.writes, 0);
});

test('the invented-data repository touches only its namespaced key', async () => {
  const { state, storage, repository } = fixture();
  const previousStore = '.true-convo-local';
  storage.data.set(previousStore, 'Invented sentinel belonging to a different store');
  repository.load();
  await repository.save(state, null);
  assert.equal(storage.data.get(previousStore), 'Invented sentinel belonging to a different store');
  assert.ok(storage.reads.every((key) => key === DESK_STORAGE_KEY));
});
