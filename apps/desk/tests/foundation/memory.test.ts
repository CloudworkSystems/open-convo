import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository, DESK_STORAGE_KEY, type StorageLike } from '../../src/adapters/browser-repository';
import { applyCommand, DomainError } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { eligibleMemoryContext } from '../../src/domain/memory';
import type { DeskState, MemoryCommand, MemorySource } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

function fixture() {
  let count = 0;
  const options = { now: () => '2026-10-08T16:00:00.000Z', id: () => `00000000-0000-4000-8000-${String(++count).padStart(12, '0')}` };
  const state = createDemoState(options);
  return { state, options, goalId: state.goals[0].id, memoryId: () => options.id() };
}

class Storage implements StorageLike {
  raw: string | null = null;
  writes = 0;
  blocked = false;
  getItem(key: string) { assert.equal(key, DESK_STORAGE_KEY); return this.raw; }
  setItem(key: string, value: string) { assert.equal(key, DESK_STORAGE_KEY); if (this.blocked) throw new Error('Invented quota failure'); this.raw = value; this.writes += 1; }
}

function teach(f: ReturnType<typeof fixture>, state = f.state, body = 'Invented writing preference: concise paragraphs.', source: MemorySource = { kind: 'direct' }) {
  const sourceBody = source.kind === 'note' ? state.notes.find((note) => note.id === source.id)?.body
    : source.kind === 'message' ? state.messages.find((message) => message.id === source.id)?.body : undefined;
  return applyCommand(state, { type: 'remember-memory', memoryId: f.memoryId(), goalId: f.goalId, body, source,
    ...(source.kind === 'direct' ? {} : { expectedSourceBody: sourceBody }) }, f.options);
}

test('opening and navigating old schema-1 workspaces does not initialize memories or rewrite original bytes', async () => {
  const f = fixture();
  const storage = new Storage();
  storage.raw = JSON.stringify(f.state);
  const before = storage.raw;
  const repository = new BrowserRepository(storage, async (operation) => operation());
  const loaded = repository.load();
  assert.equal(loaded.kind, 'ready');
  assert.equal(validateState(f.state).valid, true);
  const viewed = applyCommand(f.state, { type: 'navigate', route: 'memory' }, f.options);
  assert.equal(Object.hasOwn(viewed, 'memories'), false);
  assert.equal(Object.hasOwn(viewed, 'memoryDrafts'), false);
  assert.deepEqual(eligibleMemoryContext(viewed, f.goalId).memories, []);
  assert.equal(viewed.revision, f.state.revision);
  assert.equal(storage.raw, before);
  assert.equal(storage.writes, 0);
  if (loaded.kind === 'ready') assert.equal(JSON.stringify(loaded.state), before);
});

test('explicit direct teaching adds one scoped memory and preserves conversations, scratch notes and permissions', () => {
  const f = fixture();
  const before = JSON.stringify(f.state);
  const next = teach(f);
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(next.memories?.length, 1);
  const memory = next.memories![0];
  assert.equal(memory.goalId, f.goalId);
  assert.equal(memory.revision, 1);
  assert.equal(memory.use, 'active');
  assert.deepEqual(memory.source, { kind: 'direct' });
  assert.deepEqual(memory.undo, { operation: 'remember', afterRevision: 1, previous: null });
  for (const key of ['sessions', 'messages', 'notes', 'drafts', 'selection', 'capabilities', 'preferences'] as const) assert.deepEqual(next[key], f.state[key]);
  assert.equal(next.revision, f.state.revision + 1);
  assert.equal(validateState(next).valid, true);
  assert.deepEqual(eligibleMemoryContext(next, f.goalId).memories, [{ id: memory.id, body: memory.body }]);
  assert.deepEqual(eligibleMemoryContext(next, f.memoryId()).memories, []);
});

test('stable teaching identity makes retries harmless, including after correction or forgetting', () => {
  const f = fixture();
  const command: MemoryCommand = { type: 'remember-memory', memoryId: f.memoryId(), goalId: f.goalId, body: '  Original sample detail  ', source: { kind: 'direct' } };
  let next = applyCommand(f.state, command, f.options);
  assert.equal(applyCommand(next, command, f.options), next);
  next = applyCommand(next, { type: 'correct-memory', memoryId: command.memoryId, expectedRevision: 1, body: 'Corrected sample detail' }, f.options);
  assert.equal(applyCommand(next, command, f.options), next);
  next = applyCommand(next, { type: 'forget-memory', memoryId: command.memoryId, expectedRevision: 2 }, f.options);
  assert.equal(applyCommand(next, command, f.options), next);
  assert.equal(next.memories![0].use, 'trashed');
  assert.throws(() => applyCommand(next, { ...command, body: 'Different teaching' }, f.options), DomainError);
  assert.throws(() => applyCommand(f.state, { ...command, memoryId: f.state.notes[0].id }, f.options), DomainError);
});

test('selected source is reviewed explicitly and cannot silently cross folders, change or use incomplete messages', () => {
  const f = fixture();
  const source = f.state.messages[0];
  const command: MemoryCommand = { type: 'remember-memory', memoryId: f.memoryId(), goalId: f.goalId, body: 'Chosen excerpt', source: { kind: 'message', id: source.id }, expectedSourceBody: source.body };
  const next = applyCommand(f.state, command, f.options);
  assert.equal(validateState(next).valid, true);
  assert.throws(() => applyCommand(f.state, { ...command, expectedSourceBody: 'Unreviewed original' }, f.options), DomainError);
  assert.throws(() => applyCommand(f.state, { ...command, expectedSourceBody: undefined }, f.options), DomainError);
  const other = applyCommand(f.state, { type: 'create-goal', title: 'Other sample folder', empty: true }, f.options);
  assert.throws(() => applyCommand(other, { ...command, goalId: other.selection.goalId! }, f.options), DomainError);
  const running = structuredClone(f.state); running.messages[0].status = 'running';
  assert.throws(() => applyCommand(running, command, f.options), DomainError);
  assert.throws(() => teach(f, f.state, 'Sample', { kind: 'note', id: f.memoryId() }), DomainError);
});

test('correct/forget/context canaries exclude old versions, selected raw sources, Trash and view-only restores', () => {
  const f = fixture();
  f.state.notes[0].body = 'SOURCE-CANARY-DO-NOT-RECALL plus unrelated sample text';
  let next = teach(f, f.state, 'OLD-MEMORY-CANARY', { kind: 'note', id: f.state.notes[0].id });
  const memoryId = next.memories![0].id;
  next = applyCommand(next, { type: 'correct-memory', memoryId, expectedRevision: 1, body: 'CURRENT-MEMORY-CANARY' }, f.options);
  let context = eligibleMemoryContext(next, f.goalId);
  assert.ok(JSON.stringify(context).includes('CURRENT-MEMORY-CANARY'));
  assert.ok(!JSON.stringify(context).includes('OLD-MEMORY-CANARY'));
  assert.ok(!JSON.stringify(context).includes('SOURCE-CANARY-DO-NOT-RECALL'));
  assert.equal(next.memories![0].history[0].body, 'OLD-MEMORY-CANARY');
  next = applyCommand(next, { type: 'forget-memory', memoryId, expectedRevision: 2 }, f.options);
  assert.equal(next.notes[0].body, f.state.notes[0].body);
  context = eligibleMemoryContext(next, f.goalId);
  assert.equal(context.memories.length, 0);
  assert.ok(!JSON.stringify(context).includes('CURRENT-MEMORY-CANARY'));
  assert.ok(!JSON.stringify(context).includes('SOURCE-CANARY-DO-NOT-RECALL'));
  next = applyCommand(next, { type: 'restore-memory', memoryId, expectedRevision: 3, use: 'view-only' }, f.options);
  assert.equal(eligibleMemoryContext(next, f.goalId).memories.length, 0);
  next = applyCommand(next, { type: 'restore-memory', memoryId, expectedRevision: 4, use: 'active' }, f.options);
  assert.deepEqual(eligibleMemoryContext(next, f.goalId).memories, [{ id: memoryId, body: 'CURRENT-MEMORY-CANARY' }]);
  assert.equal(eligibleMemoryContext(next, f.goalId).notes.length, 0);
  assert.deepEqual(next.capabilities, f.state.capabilities);
  assert.equal(validateState(next).valid, true);
});

test('forgetting one source-derived memory excludes other derivatives while unchosen unrelated sources remain eligible', () => {
  const f = fixture();
  f.state.messages[0].body = 'Selected original source canary';
  let next = teach(f, f.state, 'First derived detail', { kind: 'message', id: f.state.messages[0].id });
  next = teach(f, next, 'Another derivative of that same source', { kind: 'message', id: f.state.messages[0].id });
  const memoryId = next.memories![0].id;
  assert.equal(eligibleMemoryContext(next, f.goalId).memories.length, 2);
  next = applyCommand(next, { type: 'forget-memory', memoryId, expectedRevision: 1 }, f.options);
  const context = eligibleMemoryContext(next, f.goalId);
  assert.equal(context.memories.length, 0);
  assert.equal(context.messages.length, 0);
  assert.deepEqual(context.notes, f.state.notes.map(({ id, body }) => ({ id, body })));
  assert.equal(next.messages[0].body, 'Selected original source canary');
});

test('source session moves preserve historical memory scope and block reuse in either folder without invalidating saved work', () => {
  const f = fixture();
  let next = teach(f, f.state, 'Scoped sample memory', { kind: 'message', id: f.state.messages[0].id });
  next = applyCommand(next, { type: 'create-goal', title: 'Second sample folder', empty: true }, f.options);
  const otherGoal = next.selection.goalId!;
  next = applyCommand(next, { type: 'move-session', sessionId: f.state.sessions[0].id, goalId: otherGoal }, f.options);
  assert.equal(validateState(next).valid, true);
  assert.equal(next.memories![0].goalId, f.goalId);
  assert.equal(eligibleMemoryContext(next, f.goalId).memories.length, 0);
  assert.equal(eligibleMemoryContext(next, otherGoal).memories.length, 0);
  assert.equal(eligibleMemoryContext(next, otherGoal).messages.length, 0);
  assert.equal(next.messages[0].body, f.state.messages[0].body);
});

test('context for another folder exposes neither source text nor foreign source identities', () => {
  const f = fixture();
  let next = teach(f, f.state, 'First-folder-only memory', { kind: 'note', id: f.state.notes[0].id });
  next = applyCommand(next, { type: 'create-goal', title: 'Separate sample folder', empty: true }, f.options);
  const context = eligibleMemoryContext(next, next.selection.goalId!);
  assert.deepEqual(context, { memories: [], messages: [], notes: [], excludedSourceIds: [] });
});

test('Undo is flat, restores the exact previous value, and cannot undo an older superseded mutation', () => {
  const f = fixture();
  let next = teach(f, f.state, 'Original sample detail');
  const memoryId = next.memories![0].id;
  next = applyCommand(next, { type: 'correct-memory', memoryId, expectedRevision: 1, body: 'New sample detail' }, f.options);
  const undoRevision = next.memories![0].revision;
  next = applyCommand(next, { type: 'forget-memory', memoryId, expectedRevision: 2 }, f.options);
  assert.throws(() => applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: undoRevision }, f.options), DomainError);
  next = applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: 3 }, f.options);
  assert.equal(next.memories![0].body, 'New sample detail');
  assert.equal(next.memories![0].use, 'active');
  assert.equal(next.memories![0].undo, null);
  assert.throws(() => applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: 4 }, f.options), DomainError);
  next = applyCommand(next, { type: 'correct-memory', memoryId, expectedRevision: 4, body: 'Newest detail' }, f.options);
  next = applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: 5 }, f.options);
  assert.equal(next.memories![0].body, 'New sample detail');
  assert.equal(validateState(next).valid, true);
  assert.equal(next.memories![0].history.length, 6);
});

test('Undo Remember excludes the memory without erasing its history, and Undo view-only Restore returns it to Trash', () => {
  const f = fixture();
  let next = teach(f);
  const memoryId = next.memories![0].id;
  next = applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: 1 }, f.options);
  assert.equal(next.memories![0].use, 'trashed');
  assert.equal(next.memories![0].history.length, 2);
  assert.equal(eligibleMemoryContext(next, f.goalId).memories.length, 0);
  next = applyCommand(next, { type: 'restore-memory', memoryId, expectedRevision: 2, use: 'view-only' }, f.options);
  next = applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: 3 }, f.options);
  assert.equal(next.memories![0].use, 'trashed');
  assert.equal(validateState(next).valid, true);
});

test('teaching/correction drafts survive navigation and reload but never enter context; failed saves preserve the attempt', async () => {
  const f = fixture(); const storage = new Storage(); const repository = new BrowserRepository(storage, async (operation) => operation());
  assert.equal((await repository.save(f.state, null)).kind, 'saved');
  let next = applyCommand(f.state, { type: 'set-memory-draft', goalId: f.goalId, draft: { memoryId: f.memoryId(), body: 'UNSENT-DRAFT-CANARY', source: { kind: 'direct' } } }, f.options);
  next = applyCommand(next, { type: 'navigate', route: 'data' }, f.options);
  assert.equal((await repository.save(next, f.state.revision)).kind, 'saved');
  const loaded = repository.load(); assert.equal(loaded.kind, 'ready');
  if (loaded.kind !== 'ready') return;
  assert.equal(loaded.state.memoryDrafts![f.goalId].body, 'UNSENT-DRAFT-CANARY');
  assert.ok(!JSON.stringify(eligibleMemoryContext(loaded.state, f.goalId)).includes('UNSENT-DRAFT-CANARY'));
  const draft = next.memoryDrafts![f.goalId];
  next = applyCommand(next, { type: 'remember-memory', memoryId: draft.memoryId, goalId: f.goalId, body: 'Committed sample memory', source: draft.source }, f.options);
  assert.equal(next.memoryDrafts![f.goalId], undefined);
  next = applyCommand(next, { type: 'set-memory-correction-draft', memoryId: draft.memoryId, expectedRevision: 1, text: 'UNSAVED-CORRECTION-CANARY' }, f.options);
  assert.equal(next.memories![0].revision, 1);
  assert.ok(!JSON.stringify(eligibleMemoryContext(next, f.goalId)).includes('UNSAVED-CORRECTION-CANARY'));
  const oldRaw = storage.raw;
  storage.blocked = true;
  const failed = await repository.save(next, loaded.state.revision);
  assert.equal(failed.kind, 'failed');
  if (failed.kind === 'failed') assert.equal(failed.attemptedState.memories![0].correctionDraft, 'UNSAVED-CORRECTION-CANARY');
  assert.equal(storage.raw, oldRaw);
  storage.blocked = false;
  assert.equal((await repository.save(next, loaded.state.revision)).kind, 'saved');
  const afterRetry = repository.load();
  if (afterRetry.kind === 'ready') assert.equal(afterRetry.state.memories![0].correctionDraft, 'UNSAVED-CORRECTION-CANARY');
  else assert.fail('Retry failed to preserve correction draft.');
});

test('stale correction/draft/forget/restore/Undo preconditions retain newer text and other-folder work', () => {
  const f = fixture(); let next = teach(f);
  const memoryId = next.memories![0].id;
  next = applyCommand(next, { type: 'correct-memory', memoryId, expectedRevision: 1, body: 'Newer text' }, f.options);
  next = applyCommand(next, { type: 'create-goal', title: 'Unrelated folder', empty: true }, f.options);
  const before = JSON.stringify(next);
  for (const command of [
    { type: 'correct-memory', body: 'Stale overwrite' }, { type: 'set-memory-correction-draft', text: 'Stale draft' },
    { type: 'forget-memory' }, { type: 'restore-memory', use: 'view-only' }, { type: 'undo-memory' },
  ]) assert.throws(() => applyCommand(next, { ...command, memoryId, expectedRevision: 1 } as MemoryCommand, f.options), DomainError);
  assert.equal(JSON.stringify(next), before);
  next = applyCommand(next, { type: 'forget-memory', memoryId, expectedRevision: 2 }, f.options);
  assert.equal(next.memories![0].goalId, f.goalId);
  assert.notEqual(next.selection.goalId, f.goalId);
});

test('two editors cannot overwrite a newer memory revision in the same storage authority', async () => {
  const f = fixture(); const storage = new Storage(); const repository = new BrowserRepository(storage, async (operation) => operation());
  const first = teach(f); assert.equal((await repository.save(first, null)).kind, 'saved');
  const memoryId = first.memories![0].id;
  const corrected = applyCommand(first, { type: 'correct-memory', memoryId, expectedRevision: 1, body: 'First editor result' }, f.options);
  const forgotten = applyCommand(first, { type: 'forget-memory', memoryId, expectedRevision: 1 }, f.options);
  assert.equal((await repository.save(corrected, first.revision)).kind, 'saved');
  const conflict = await repository.save(forgotten, first.revision);
  assert.equal(conflict.kind, 'conflict');
  if (conflict.kind === 'conflict') {
    assert.equal(conflict.currentState!.memories![0].body, 'First editor result');
    assert.equal(conflict.attemptedState.memories![0].use, 'trashed');
  }
});

test('corrupt memory fields/history/undo/source/identity are rejected in full and established bytes remain untouched', async () => {
  const f = fixture(); const good = teach(f); const memory = good.memories![0];
  const variants: DeskState[] = [];
  const corrupt = (mutate: (next: DeskState) => void) => { const next = structuredClone(good); mutate(next); variants.push(next); };
  corrupt((next) => { next.memories![0].source = { kind: 'note', id: f.memoryId() }; });
  corrupt((next) => { next.memories![0].revision = 2; });
  corrupt((next) => { next.memories![0].history[0].body = 'Unexpected rewrite'; });
  corrupt((next) => { next.memories![0].undo!.previous = { body: 'Unrelated prior value', use: 'active' }; });
  corrupt((next) => { next.memories![0].undo!.afterRevision = 0; });
  corrupt((next) => { next.memories![0].id = next.notes[0].id; });
  corrupt((next) => { next.memories![0].goalId = f.memoryId(); });
  corrupt((next) => { next.memories![0].correctionDraft = 'x'.repeat(4001); });
  corrupt((next) => { next.memories![0].history[0].changedAt = 'not-time'; });
  corrupt((next) => { Object.assign(next.memories![0], { cloudGrant: true }); });
  corrupt((next) => { next.memoryDrafts = { [f.goalId]: { memoryId: memory.id, body: '', source: { kind: 'direct' } } }; });
  for (const next of variants) {
    assert.equal(validateState(next).valid, false);
    const storage = new Storage(); storage.raw = JSON.stringify(next); const raw = storage.raw;
    const repository = new BrowserRepository(storage, async (operation) => operation());
    assert.equal(repository.load().kind, 'invalid');
    assert.equal((await repository.save(good, good.revision)).kind, 'failed');
    assert.equal(storage.raw, raw); assert.equal(storage.writes, 0);
  }
});

test('history transition corruption cannot revive a trashed entry or replace an Undo snapshot', () => {
  const f = fixture(); let next = teach(f);
  const memoryId = next.memories![0].id;
  next = applyCommand(next, { type: 'forget-memory', memoryId, expectedRevision: 1 }, f.options);
  const bad = structuredClone(next);
  bad.memories![0].history[1].use = 'active'; bad.memories![0].use = 'active';
  assert.equal(validateState(bad).valid, false);
  next = applyCommand(next, { type: 'undo-memory', memoryId, expectedRevision: 2 }, f.options);
  const badUndo = structuredClone(next);
  badUndo.memories![0].history[2].body = 'Forged restore'; badUndo.memories![0].body = 'Forged restore';
  assert.equal(validateState(badUndo).valid, false);
});

test('backward wall clocks keep memory history ordered and corrections valid', () => {
  const f = fixture(); let next = teach(f);
  const memoryId = next.memories![0].id;
  next = applyCommand(next, { type: 'correct-memory', memoryId, expectedRevision: 1, body: 'Future sample detail' }, { ...f.options, now: () => '2027-10-08T16:00:00.000Z' });
  next = applyCommand(next, { type: 'forget-memory', memoryId, expectedRevision: 2 }, { ...f.options, now: () => '2025-10-08T16:00:00.000Z' });
  assert.equal(next.memories![0].updatedAt, '2027-10-08T16:00:00.000Z');
  assert.equal(next.memories![0].history[2].changedAt, '2027-10-08T16:00:00.000Z');
  assert.equal(validateState(next).valid, true);
});

test('blank/oversized teaching and invalid restore choices refuse to change state', () => {
  const f = fixture(); assert.throws(() => teach(f, f.state, '   '), DomainError);
  assert.throws(() => teach(f, f.state, 'x'.repeat(4001)), DomainError);
  const next = teach(f); const before = JSON.stringify(next);
  assert.throws(() => applyCommand(next, { type: 'restore-memory', memoryId: next.memories![0].id, expectedRevision: 1, use: 'cloud' } as unknown as MemoryCommand, f.options), DomainError);
  assert.equal(JSON.stringify(next), before);
});
