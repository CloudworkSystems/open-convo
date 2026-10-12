import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository } from '../../src/adapters/browser-repository';
import { applyCommand, DomainError, isViewCommand } from '../../src/domain/commands';
import type { ConversationRun, ParticipantEvent } from '../../src/domain/conversation-run-types';
import { acknowledgeUnreachableCleanup, appendParticipantEvent, chunkRunText, closeConversationRun, createConversationRun, isConversationRunClosed, validateConversationRun } from '../../src/domain/conversation-runs';
import { canAdmitConversationRun, canSaveConversationWorkspace, canSaveConversationWorkspaceWithRuns, captureConversationWorkspace, conversationRecoveryReserve, prepareConversationRun, RESERVED_RUN_ACKNOWLEDGMENT_BYTES, RESERVED_RUN_RECOVERY_BYTES, saveConversationRunCheckpoint, WORKSPACE_RUN_LIMIT_BYTES, WORKSPACE_TEXT_LIMIT_BYTES } from '../../src/domain/conversation-workspace';
import { createDemoState } from '../../src/domain/demo';
import type { DeskCommand, DeskState } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

const time = '2026-10-09T16:30:00.000Z';
const later = '2026-10-09T16:31:00.000Z';
const newest = '2026-10-09T16:32:00.000Z';
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function fixture(text = 'Invented input only.'): { state: DeskState; run: ConversationRun; draft: string } {
  let nextId = 0;
  let state = createDemoState({ id: () => id(++nextId), now: () => time });
  state = applyCommand(state, { type: 'set-draft', sessionId: state.sessions[0].id, text }, { now: () => time, id: () => id(++nextId) });
  const result = createConversationRun({ runId: id(100), sessionId: state.sessions[0].id,
    userMessageId: id(101), assistantMessageId: id(102), participant: {
      id: 'test-participant', label: 'Invented participant', model: 'test-model', executionHost: 'test-host',
    }, input: text, createdAt: later });
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Fixture run failed.');
  return { state, run: result.run, draft: text };
}

function event(run: ConversationRun, value: { type: ParticipantEvent['type']; text?: string; at?: string }): ConversationRun {
  const result = appendParticipantEvent(run, { runId: run.runId, sessionId: run.sessionId,
    sequence: run.lastSequence + 1, at: value.at ?? newest, ...value } as ParticipantEvent);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Fixture event failed.');
  return result.run;
}

function reject(operation: () => unknown, expected = 'The conversation checkpoint could not be applied. Existing work was kept.'): void {
  assert.throws(operation, (error) => error instanceof DomainError && error.message === expected);
}
const preparationRefusal = 'The conversation could not be prepared. The draft and saved work were kept.';

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
}

test('reading and ordinary edits keep schema 1 and original simulation provenance', () => {
  const { state } = fixture();
  const before = JSON.stringify(state);
  const result = validateState(state);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.state, state);
  assert.equal(JSON.stringify(state), before);
  const edited = applyCommand(state, { type: 'rename-session', sessionId: state.sessions[0].id, title: 'Invented new name' }, { now: () => later, id: () => id(50) });
  assert.equal(edited.schemaVersion, 1);
  assert.equal(Object.hasOwn(edited, 'conversationRuns'), false);
  assert.deepEqual(edited.capabilities, state.capabilities);
  assert.deepEqual(edited.messages, state.messages);
});

test('first deliberate preparation upgrades a clone, captures exact draft and leaves simulation records intact', () => {
  const { state, run, draft } = fixture('  Invented\n🧪 input\t ');
  state.messages[0].body += '\nPreserve this literal: 🧪 e\u0301';
  state.messages[0].status = 'interrupted';
  const before = JSON.stringify(state);
  const messages = JSON.stringify(state.messages);
  freeze(state);
  freeze(run);
  const next = prepareConversationRun(state, run, draft);
  assert.notEqual(next, state);
  assert.equal(JSON.stringify(state), before);
  assert.equal(next.schemaVersion, 2);
  assert.deepEqual(next.capabilities, { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' });
  assert.equal(next.conversationRuns?.length, 1);
  assert.deepEqual(next.conversationRuns?.[0], run);
  assert.notEqual(next.conversationRuns?.[0], run);
  assert.equal(next.conversationRuns?.[0].inputChunks.join(''), draft);
  assert.equal(next.drafts[run.sessionId], '');
  assert.equal(JSON.stringify(next.messages), messages);
  assert.deepEqual(next.activity, state.activity);
  assert.deepEqual(next.sessions, state.sessions);
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.updatedAt, later);
  assert.equal(validateState(next).valid, true);
  assert.equal(validateState(JSON.parse(JSON.stringify(next))).valid, true);
});

test('schema and capability metadata must agree; no implicit read migration or journal stripping', () => {
  const { state, run, draft } = fixture();
  const next = prepareConversationRun(state, run, draft);
  for (const invalid of [
    { ...state, conversationRuns: [] },
    { ...state, schemaVersion: 2 },
    { ...next, conversationRuns: undefined },
    { ...next, conversationRuns: null },
    { ...next, capabilities: state.capabilities },
    { ...state, capabilities: next.capabilities },
    { ...next, capabilities: { ...next.capabilities, native: 'available' } },
    { ...next, extraField: 'do not silently strip' },
  ]) assert.equal(validateState(invalid).valid, false);
  assert.equal(state.schemaVersion, 1);
  assert.equal(Object.hasOwn(state, 'conversationRuns'), false);
});

test('preparation refuses stale or altered input, unknown session, non-prepared run and exhausted revision', () => {
  const { state, run, draft } = fixture();
  const before = JSON.stringify(state);
  reject(() => prepareConversationRun(state, run, `${draft} changed`), preparationRefusal);
  reject(() => prepareConversationRun({ ...state, drafts: { [run.sessionId]: 'newer unsent draft' } }, run, draft), preparationRefusal);
  reject(() => prepareConversationRun(state, { ...run, inputChunks: ['another input'] }, draft), preparationRefusal);
  reject(() => prepareConversationRun(state, { ...run, sessionId: id(500) }, draft), preparationRefusal);
  reject(() => prepareConversationRun(state, event(run, { type: 'started' }), draft), preparationRefusal);
  reject(() => prepareConversationRun({ ...state, revision: Number.MAX_SAFE_INTEGER }, run, draft), preparationRefusal);
  assert.equal(JSON.stringify(state), before);
});

test('run identities are unique against every workspace identity including memories and unsent teaching drafts', () => {
  const fixtureValue = fixture();
  let { state } = fixtureValue;
  const { run, draft } = fixtureValue;
  const goalId = state.goals[0].id;
  state = applyCommand(state, { type: 'remember-memory', goalId, memoryId: id(200), body: 'Invented fact.', source: { kind: 'direct' } }, { now: () => time, id: () => id(201) });
  state = applyCommand(state, { type: 'set-memory-draft', goalId, draft: { memoryId: id(202), body: 'Invented unsent fact.', source: { kind: 'direct' } } }, { now: () => time });
  assert.equal(validateState(state).valid, true);
  const allIds = [...state.goals, ...state.sessions, ...state.messages, ...state.workItems,
    ...state.notes, ...state.activity, ...state.memories!].map((item) => item.id);
  allIds.push(id(202));
  for (const occupied of allIds) {
    for (const field of ['runId', 'userMessageId', 'assistantMessageId'] as const) {
      reject(() => prepareConversationRun(state, { ...run, [field]: occupied }, draft), preparationRefusal);
    }
  }
  const next = prepareConversationRun(state, run, draft);
  const duplicate = { ...run, runId: id(501), userMessageId: run.assistantMessageId, assistantMessageId: id(503), phase: 'completed', lastSequence: 2 };
  assert.equal(validateState({ ...next, conversationRuns: [run, duplicate] }).valid, false);
});

test('run ID collision checks recognize uppercase spellings of existing UUIDs', () => {
  const { state, run, draft } = fixture();
  state.messages[0].id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  assert.equal(validateState(state).valid, true);
  reject(() => prepareConversationRun(state, { ...run, userMessageId: state.messages[0].id.toLowerCase() }, draft), preparationRefusal);
});

test('only one unfinished run per session, including unknown runs, while another session remains independent', () => {
  let { state, run, draft } = fixture();
  state = prepareConversationRun(state, run, draft);
  const another = { ...run, runId: id(300), userMessageId: id(301), assistantMessageId: id(302) };
  state = applyCommand(state, { type: 'set-draft', sessionId: run.sessionId, text: draft }, { now: () => later });
  reject(() => prepareConversationRun(state, another, draft), preparationRefusal);
  assert.equal(validateState({ ...state, conversationRuns: [run, another] }).valid, false);
  const uncertain = { ...state, conversationRuns: [{ ...run, phase: 'unknown' as const }] };
  assert.equal(validateState(uncertain).valid, true);
  reject(() => prepareConversationRun(uncertain, another, draft), preparationRefusal);
  let index = 400;
  state = applyCommand(state, { type: 'create-session', goalId: state.goals[0].id }, { now: () => later, id: () => id(index++) });
  const secondSession = state.sessions.at(-1)!.id;
  state = applyCommand(state, { type: 'set-draft', sessionId: secondSession, text: draft }, { now: () => later });
  const next = prepareConversationRun(state, { ...another, sessionId: secondSession }, draft);
  assert.equal(next.conversationRuns?.length, 2);
  assert.equal(next.drafts[run.sessionId], draft);
  assert.equal(next.drafts[secondSession], '');
});

test('workspace validation rejects unknown session and run chronology outside the owning workspace', () => {
  const { state, run, draft } = fixture();
  const next = prepareConversationRun(state, run, draft);
  const earlier = '2026-10-08T16:30:00.000Z';
  for (const invalid of [
    { ...run, sessionId: id(999) },
    { ...run, createdAt: earlier, updatedAt: earlier },
    { ...run, createdAt: newest, updatedAt: newest },
  ]) assert.equal(validateState({ ...next, conversationRuns: [invalid] }).valid, false);
});

test('checkpoint coalesces observed events, preserves append-only Unicode text and never mutates input', () => {
  const { state, run, draft } = fixture('🧪'.repeat(10_000));
  const prepared = prepareConversationRun(state, run, draft);
  const started = event(run, { type: 'started' });
  const first = event(started, { type: 'text', text: 'a'.repeat(16_383) });
  const savedFirst = saveConversationRunCheckpoint(prepared, first, 0);
  const output = `${'🧪'.repeat(20_000)}\ne\u0301`;
  const second = textEvents(first, output);
  const completed = event(second, { type: 'completed' });
  const before = JSON.stringify(savedFirst);
  freeze(savedFirst);
  freeze(completed);
  const next = saveConversationRunCheckpoint(savedFirst, completed, first.lastSequence);
  assert.equal(JSON.stringify(savedFirst), before);
  assert.equal(next.conversationRuns?.[0].outputChunks.join(''), 'a'.repeat(16_383) + output);
  assert.equal(next.conversationRuns?.[0].inputChunks.join(''), draft);
  assert.equal(next.conversationRuns?.[0].phase, 'completed');
  assert.equal(next.revision, savedFirst.revision + 1);
  assert.equal(next.updatedAt, newest);
  assert.deepEqual(next.messages, state.messages);
  assert.equal(validateState(JSON.parse(JSON.stringify(next))).valid, true);
});

test('identical checkpoint retries are no-ops, including the previous expected sequence', () => {
  const { state, run, draft } = fixture();
  const prepared = prepareConversationRun(state, run, draft);
  const started = event(run, { type: 'started' });
  const next = saveConversationRunCheckpoint(prepared, started, 0);
  assert.equal(saveConversationRunCheckpoint(next, structuredClone(started), 0), next);
  assert.equal(saveConversationRunCheckpoint(next, { ...started, participant: {
    executionHost: started.participant.executionHost, model: started.participant.model,
    label: started.participant.label, id: started.participant.id,
  } }, 1), next);
  assert.equal(saveConversationRunCheckpoint(prepared, run, 0), prepared);
});

test('changed checkpoints require the stored sequence and cannot alter identity, origin or captured input', () => {
  const { state, run, draft } = fixture();
  const prepared = prepareConversationRun(state, run, draft);
  const started = event(run, { type: 'started' });
  const stored = saveConversationRunCheckpoint(prepared, started, 0);
  const next = event(started, { type: 'text', text: 'Invented output' });
  reject(() => saveConversationRunCheckpoint(stored, next, 0));
  reject(() => saveConversationRunCheckpoint(stored, next, Number.NaN));
  for (const changed of [
    { ...next, runId: id(900) }, { ...next, sessionId: id(901) },
    { ...next, userMessageId: id(902) }, { ...next, assistantMessageId: id(903) },
    { ...next, createdAt: time }, { ...next, inputChunks: ['different input'] },
    ...(['id', 'label', 'model', 'executionHost'] as const).map((field) => ({ ...next, participant: { ...next.participant, [field]: 'changed' } })),
  ]) reject(() => saveConversationRunCheckpoint(stored, changed, 1));
  reject(() => saveConversationRunCheckpoint(stored, { ...started, phase: 'unknown' }, 1));
  reject(() => saveConversationRunCheckpoint(stored, run, 1));
});

test('saved prefixes cannot shrink or be replaced; older timestamps cannot rewrite checkpoint time', () => {
  const { state, run, draft } = fixture();
  const text = event(event(run, { type: 'started' }), { type: 'text', text: 'Keep this prefix 🧪' });
  const stored = saveConversationRunCheckpoint(prepareConversationRun(state, run, draft), text, 0);
  const next = event(text, { type: 'text', text: ' and tail' });
  for (const changed of [
    { ...next, outputChunks: ['Keep'] },
    { ...next, outputChunks: ['Replace the prefix 🧪 and tail'] },
    { ...next, outputChunks: [] },
    { ...next, updatedAt: later },
    { ...next, lastSequence: text.lastSequence },
  ]) reject(() => saveConversationRunCheckpoint(stored, changed, text.lastSequence));
});

test('terminal and unresolved records cannot revive or change; terminal sessions can prepare a new run', () => {
  const { state, run, draft } = fixture();
  const prepared = prepareConversationRun(state, run, draft);
  const started = event(run, { type: 'started' });
  for (const type of ['completed', 'stopped', 'failed'] as const) {
    const terminal = event(started, { type });
    const stored = saveConversationRunCheckpoint(prepared, terminal, 0);
    assert.equal(saveConversationRunCheckpoint(stored, terminal, 0), stored);
    reject(() => saveConversationRunCheckpoint(stored, { ...terminal, phase: 'running', lastSequence: 3 }, 2));
    reject(() => saveConversationRunCheckpoint(stored, { ...terminal, lastSequence: 3 }, 2));
    const withDraft = applyCommand(stored, { type: 'set-draft', sessionId: run.sessionId, text: draft }, { now: () => newest });
    const next = prepareConversationRun(withDraft, { ...run, runId: id(500), userMessageId: id(501), assistantMessageId: id(502) }, draft);
    assert.equal(next.conversationRuns?.length, 2);
  }
  const unknown = { ...started, phase: 'unknown' as const };
  const storedUnknown = { ...prepared, updatedAt: unknown.updatedAt, conversationRuns: [unknown] };
  assert.equal(validateState(storedUnknown).valid, true);
  reject(() => saveConversationRunCheckpoint(storedUnknown, { ...started, lastSequence: 2 }, 1));
});

test('checkpoint touches only its run and revision/time; later drafts and other session work survive', () => {
  const { state, run, draft } = fixture();
  let prepared = prepareConversationRun(state, run, draft);
  const afterRun = '2026-10-10T00:00:00.000Z';
  prepared = applyCommand(prepared, { type: 'set-draft', sessionId: run.sessionId, text: 'Newer unsent draft.' }, { now: () => afterRun });
  const started = event(run, { type: 'started' });
  const next = saveConversationRunCheckpoint(prepared, started, 0);
  assert.equal(next.updatedAt, afterRun);
  assert.deepEqual(next.drafts, prepared.drafts);
  assert.deepEqual(next.sessions, prepared.sessions);
  assert.deepEqual(next.messages, prepared.messages);
  assert.deepEqual(next.activity, prepared.activity);
  assert.deepEqual(next.selection, prepared.selection);
  assert.equal(next.revision, prepared.revision + 1);
  assert.equal(validateState(next).valid, true);
});

test('malformed run or workspace refuses with fixed DomainError text and exposes no input content', () => {
  const { state, run, draft } = fixture();
  reject(() => prepareConversationRun({ ...state, revision: -1 }, run, draft), 'The conversation workspace is invalid. No changes were applied.');
  const malformed = { ...run, outputChunks: ['\uD800'] };
  assert.equal(validateConversationRun(malformed), false);
  reject(() => prepareConversationRun(state, malformed, draft), preparationRefusal);
  reject(() => saveConversationRunCheckpoint(prepareConversationRun(state, run, draft), malformed, 0));
});

test('preparation and checkpoint values are not durable until repository commit; failed storage preserves prior bytes', async () => {
  const { state, run, draft } = fixture();
  let savedBytes: string | null = null;
  let failWrites = false;
  const repository = new BrowserRepository({
    getItem: () => savedBytes,
    setItem: (_key, value) => { if (failWrites) throw new Error('Invented storage failure.'); savedBytes = value; },
  }, async (operation) => operation());
  assert.equal((await repository.save(state, null)).kind, 'saved');
  const schemaOneBytes = savedBytes;
  const prepared = prepareConversationRun(state, run, draft);
  assert.equal(savedBytes, schemaOneBytes);
  assert.equal((await repository.save(prepared, state.revision)).kind, 'saved');
  const preparedBytes = savedBytes;
  const reopened = repository.load();
  assert.equal(reopened.kind, 'ready');
  if (reopened.kind !== 'ready') throw new Error('Fixture reopen failed.');
  assert.equal(reopened.state.schemaVersion, 2);
  assert.deepEqual(reopened.state.conversationRuns, [run]);
  assert.deepEqual(reopened.state.messages, state.messages);
  const checkpoint = saveConversationRunCheckpoint(reopened.state, event(run, { type: 'started' }), 0);
  assert.equal(savedBytes, preparedBytes);
  failWrites = true;
  const result = await repository.save(checkpoint, prepared.revision);
  assert.equal(result.kind, 'failed');
  assert.equal(savedBytes, preparedBytes);
  const afterFailure = repository.load();
  assert.equal(afterFailure.kind, 'ready');
  if (afterFailure.kind === 'ready') assert.equal(afterFailure.state.conversationRuns?.[0].phase, 'prepared');
});

function textEvents(run: ConversationRun, text: string): ConversationRun {
  const chunks = chunkRunText(text);
  if (chunks.kind !== 'ok') throw new Error('Fixture chunks refused.');
  for (const chunk of chunks.chunks) run = event(run, { type: 'text', text: chunk });
  return run;
}
function closed(run: ConversationRun, at = '2026-10-09T16:33:00.000Z'): ConversationRun {
  const result = closeConversationRun(run, { kind: 'unknown', reason: 'user-closed', at });
  if (result.kind !== 'ok') throw new Error('Fixture closure refused.');
  return result.run;
}
function longWorkspace(active = false): { state: DeskState; run: ConversationRun; draft: string } {
  const f = fixture();
  const runs: ConversationRun[] = [];
  for (let index = 0; index < 4; index++) {
    const prepared = { ...f.run, runId: id(600 + index * 10), userMessageId: id(601 + index * 10), assistantMessageId: id(602 + index * 10) };
    let run = textEvents(event(prepared, { type: 'started' }), 'x'.repeat(active && index === 3 ? 240_000 : 250_000));
    if (!(active && index === 3)) run = event(run, { type: 'completed' });
    runs.push(run);
  }
  const state: DeskState = { ...f.state, schemaVersion: 2, updatedAt: newest, conversationRuns: runs,
    capabilities: { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' } };
  assert.equal(validateState(state).valid, true);
  return { state, run: active ? runs.at(-1)! : f.run, draft: f.draft };
}
const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
// Independently serialize the largest valid view to check exact capacity rather
// than copying the production byte allowance.
function viewReserve(state: DeskState): number {
  return serializedBytes({ goalId: id(1), sessionId: id(2), route: 'sessions' })
    + serializedBytes({ theme: 'system', nexusView: 'navigator' })
    - serializedBytes(state.selection) - serializedBytes(state.preferences);
}
function padTo(state: DeskState, target: number): DeskState {
  const next = structuredClone(state);
  const bytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
  assert.ok(target >= bytes && target - bytes < 60_000);
  next.notes[0].body += 'p'.repeat(target - bytes);
  assert.equal(new TextEncoder().encode(JSON.stringify(next)).byteLength, target);
  assert.equal(validateState(next).valid, true);
  return next;
}

test('an explicit unknown closure records the same prefix once, advances only workspace time and unblocks its session', () => {
  const { state, run, draft } = fixture();
  const running = textEvents(event(run, { type: 'started' }), 'Literal saved prefix 🧪');
  const recorded = saveConversationRunCheckpoint(prepareConversationRun(state, run, draft), running, 0);
  const closure = closed(running);
  const next = saveConversationRunCheckpoint(recorded, closure, running.lastSequence);
  assert.equal(next.conversationRuns?.[0].phase, running.phase);
  assert.equal(next.conversationRuns?.[0].lastSequence, running.lastSequence);
  assert.equal(next.conversationRuns?.[0].updatedAt, running.updatedAt);
  assert.equal(next.updatedAt, closure.closure!.at);
  assert.equal(next.revision, recorded.revision + 1);
  assert.deepEqual(next.conversationRuns?.[0].outputChunks, running.outputChunks);
  assert.equal(isConversationRunClosed(next.conversationRuns![0]), true);
  assert.equal(saveConversationRunCheckpoint(next, structuredClone(closure), running.lastSequence), next);
  reject(() => saveConversationRunCheckpoint(next, event(running, { type: 'text', text: 'No revival' }), running.lastSequence));
  reject(() => saveConversationRunCheckpoint(next, closed(running, '2026-10-09T16:34:00.000Z'), running.lastSequence));
  const withDraft = applyCommand(next, { type: 'set-draft', sessionId: run.sessionId, text: draft }, { now: () => next.updatedAt });
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.messages[0]), true);
  const newRun = { ...run, runId: id(900), userMessageId: id(901), assistantMessageId: id(902) };
  const prepared = prepareConversationRun(withDraft, newRun, draft);
  assert.equal(prepared.conversationRuns?.length, 2);
  assert.equal(validateState(prepared).valid, true);
});

test('same-sequence closure cannot replace evidence, change chronology or rewind the sequence', () => {
  const { state, run, draft } = fixture();
  const running = textEvents(event(run, { type: 'started' }), 'Keep the prefix');
  const recorded = saveConversationRunCheckpoint(prepareConversationRun(state, run, draft), running, 0);
  const closure = closed(running);
  for (const altered of [
    { ...closure, outputChunks: ['Replaced'] }, { ...closure, lastSequence: running.lastSequence - 1 },
    { ...closure, phase: 'unknown' as const }, { ...closure, inputChunks: ['Changed input'] },
    { ...closure, updatedAt: closure.closure!.at },
  ]) reject(() => saveConversationRunCheckpoint(recorded, altered, running.lastSequence));
  assert.equal(validateState({ ...recorded, conversationRuns: [closure] }).valid, false);
  assert.equal(validateState({ ...recorded, updatedAt: closure.closure!.at, conversationRuns: [closure] }).valid, true);
});

test('several completed long replies consume one shared budget and the next preparation refuses without touching a draft', () => {
  const f = longWorkspace();
  const state = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - RESERVED_RUN_RECOVERY_BYTES + 8);
  const before = JSON.stringify(state);
  assert.equal(canSaveConversationWorkspace(state), true);
  assert.equal(canSaveConversationWorkspace(state, RESERVED_RUN_RECOVERY_BYTES), false);
  assert.equal(canAdmitConversationRun(state, f.run), false);
  reject(() => prepareConversationRun(state, f.run, f.draft), preparationRefusal);
  assert.equal(JSON.stringify(state), before);
  assert.equal(state.drafts[f.run.sessionId], f.draft);
  assert.deepEqual(state.messages.map((message) => message.provenance), ['simulation']);
});

test('admission refuses the next text before exhausting recovery room; interrupted closure preserves the admitted prefix and fits', () => {
  const f = longWorkspace(true);
  const state = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - RESERVED_RUN_RECOVERY_BYTES - 64);
  const candidate = event(f.run, { type: 'text', text: 'z'.repeat(128) });
  const before = JSON.stringify(state);
  assert.equal(canAdmitConversationRun(state, candidate), false);
  // Rejected text is never accepted by the controller; close the retained prefix.
  assert.equal(JSON.stringify(state), before);
  const at = '2026-10-09T16:34:00.000Z';
  const result = closeConversationRun(f.run, { kind: 'interrupted', reason: 'workspace-limit', at,
    terminalEvent: { type: 'stopped', reason: 'reply-too-long', runId: f.run.runId, sessionId: f.run.sessionId,
      sequence: candidate.lastSequence + 1, at } });
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(canAdmitConversationRun(state, result.run), true);
  const saved = saveConversationRunCheckpoint(state, result.run, f.run.lastSequence);
  assert.equal(canSaveConversationWorkspace(saved), true);
  assert.equal(isConversationRunClosed(saved.conversationRuns!.at(-1)!), true);
  assert.deepEqual(saved.conversationRuns!.at(-1)!.outputChunks, f.run.outputChunks);
  assert.equal(saved.conversationRuns!.at(-1)!.lastSequence, f.run.lastSequence);
  assert.equal(saved.updatedAt, at);
});

test('hard record limit includes JSON escaping; terminal evidence cannot bypass the final one MiB ceiling', () => {
  const f = longWorkspace(true);
  const state = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - 16);
  assert.equal(canSaveConversationWorkspace(state), true);
  assert.equal(canAdmitConversationRun(state, closed(f.run)), false);
  reject(() => saveConversationRunCheckpoint(state, closed(f.run), f.run.lastSequence));
  const escaped = structuredClone(f.state);
  escaped.notes[0].body += '\u0001'.repeat(16_000);
  assert.ok(escaped.notes[0].body.length < WORKSPACE_TEXT_LIMIT_BYTES);
  assert.equal(validateState(escaped).valid, true);
  assert.equal(canSaveConversationWorkspace(escaped), false, 'six-byte JSON escaping counts against record size');
});

test('all projected fields obey the 64 KiB UTF8 ceiling while captured draft text can move into scalar-safe chunks', () => {
  const { state, run } = fixture();
  state.notes[0].body = '🧪'.repeat(WORKSPACE_TEXT_LIMIT_BYTES / 4 + 1);
  assert.equal(validateState(state).valid, true);
  assert.equal(canSaveConversationWorkspace(state), false);
  assert.equal(canAdmitConversationRun(state, run), false);
  const f = fixture('🧪'.repeat(20_000));
  assert.equal(canSaveConversationWorkspace(f.state), false);
  assert.equal(canAdmitConversationRun(f.state, f.run), true, 'captured draft clears and its text moves to <=16 KiB chunks');
  const next = prepareConversationRun(f.state, f.run, f.draft);
  assert.equal(canSaveConversationWorkspace(next), true);
  assert.equal(next.conversationRuns![0].inputChunks.join(''), f.draft);
  assert.equal(f.state.drafts[f.run.sessionId], f.draft);
});

test('mutable external workspace changes cannot reuse a cached size allowance; captured snapshots stay immutable', () => {
  const f = fixture();
  assert.equal(canAdmitConversationRun(f.state, f.run), true);
  const captured = captureConversationWorkspace(f.state);
  assert.notEqual(captured, f.state);
  f.state.notes[0].body = 'x'.repeat(WORKSPACE_TEXT_LIMIT_BYTES + 1);
  assert.equal(canAdmitConversationRun(f.state, f.run), false);
  assert.equal(canSaveConversationWorkspace(f.state), false);
  assert.equal(canAdmitConversationRun(captured, f.run), true);
  assert.throws(() => { captured.notes[0].body = 'changed'; }, TypeError);
  const other = fixture();
  const prepared = prepareConversationRun(other.state, other.run, other.draft);
  const edited = applyCommand(prepared, { type: 'set-draft', sessionId: other.run.sessionId, text: 'New draft' }, { now: () => later });
  assert.equal(edited.drafts[other.run.sessionId], 'New draft');
  assert.equal(prepared.drafts[other.run.sessionId], '');
  assert.equal(validateState(edited).valid, true);
});

test('aggregate admission includes unsaved prefixes from other active sessions and reserves each closure', () => {
  const f = longWorkspace(true);
  let sequence = 800;
  let state = applyCommand(f.state, { type: 'create-session', goalId: f.state.goals[0].id }, { now: () => newest, id: () => id(sequence++) });
  const otherSessionId = state.sessions.at(-1)!.id;
  state = applyCommand(state, { type: 'set-draft', sessionId: otherSessionId, text: f.draft }, { now: () => newest });
  const otherPrepared = { ...f.run, runId: id(850), sessionId: otherSessionId, userMessageId: id(851), assistantMessageId: id(852),
    createdAt: newest, updatedAt: newest, inputChunks: [f.draft], outputChunks: [], lastSequence: 0, phase: 'prepared' as const };
  state = prepareConversationRun(state, otherPrepared, f.draft);
  assert.equal(conversationRecoveryReserve(state), RESERVED_RUN_RECOVERY_BYTES + 1024 + 5 * RESERVED_RUN_ACKNOWLEDGMENT_BYTES);
  state = captureConversationWorkspace(padTo(state, WORKSPACE_RUN_LIMIT_BYTES - conversationRecoveryReserve(state) - 512));
  const ownCandidate = event(f.run, { type: 'text', text: 'a'.repeat(300) });
  const otherCandidate = textEvents(event(otherPrepared, { type: 'started' }), 'b'.repeat(300));
  assert.equal(canAdmitConversationRun(state, ownCandidate), true);
  assert.equal(canAdmitConversationRun(state, ownCandidate, [otherCandidate]), false);
  assert.equal(canAdmitConversationRun(state, ownCandidate, [ownCandidate]), false, 'ambiguous duplicate projection refuses');
});

test('first-migration size projection matches independently serialized bytes at the reserved ceiling', () => {
  const f = fixture('Quoted " input\n🧪');
  const state = structuredClone(f.state);
  for (let index = 0; index < 15; index++) state.notes.push({ id: id(2000 + index), goalId: state.goals[0].id, body: 'x'.repeat(64_000), createdAt: time });
  const projected: DeskState = { ...state, schemaVersion: 2, revision: state.revision + 1, updatedAt: later,
    conversationRuns: [f.run], drafts: { [f.run.sessionId]: '' },
    capabilities: { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' } };
  const extra = WORKSPACE_RUN_LIMIT_BYTES - RESERVED_RUN_RECOVERY_BYTES - RESERVED_RUN_ACKNOWLEDGMENT_BYTES - serializedBytes(projected) - viewReserve(projected);
  assert.ok(extra >= 0 && extra < 60_000);
  state.notes[0].body += 'p'.repeat(extra);
  assert.equal(canAdmitConversationRun(state, f.run), true);
  const result = prepareConversationRun(state, f.run, f.draft);
  assert.equal(serializedBytes(result) + viewReserve(result), WORKSPACE_RUN_LIMIT_BYTES - RESERVED_RUN_RECOVERY_BYTES - RESERVED_RUN_ACKNOWLEDGMENT_BYTES);
  state.notes[0].body += 'x';
  assert.equal(canAdmitConversationRun(state, f.run), false);
});

test('one checkpoint can atomically retain an admitted unsaved prefix and its explicit closure', () => {
  const f = fixture();
  const prepared = prepareConversationRun(f.state, f.run, f.draft);
  const started = event(f.run, { type: 'started' });
  const recorded = saveConversationRunCheckpoint(prepared, started, 0);
  const observed = textEvents(started, 'Observed after the last checkpoint 🧪');
  const closure = closed(observed);
  const result = saveConversationRunCheckpoint(recorded, closure, started.lastSequence);
  assert.equal(result.revision, recorded.revision + 1, 'one whole-workspace value, not a hidden intermediate write');
  assert.deepEqual(result.conversationRuns?.[0], closure);
  assert.equal(result.conversationRuns?.[0].lastSequence, observed.lastSequence);
  assert.equal(result.conversationRuns?.[0].updatedAt, observed.updatedAt);
  assert.equal(result.updatedAt, closure.closure!.at);
  assert.deepEqual(recorded.conversationRuns?.[0], started);
  assert.equal(saveConversationRunCheckpoint(result, closure, started.lastSequence), result);
});

test('ordinary edits cannot consume capacity already owned by an accepted unsaved prefix', () => {
  const f = longWorkspace(true);
  const observed = textEvents(f.run, 'v'.repeat(4096));
  assert.equal(canAdmitConversationRun(f.state, observed), true);
  const edited = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - 1024 - 64);
  const before = JSON.stringify(edited);
  assert.equal(canSaveConversationWorkspace(edited, 1024), true, 'checking only the stored run misses retained output');
  assert.equal(canSaveConversationWorkspaceWithRuns(edited, [observed]), false);
  assert.equal(JSON.stringify(edited), before);
  assert.equal(canSaveConversationWorkspaceWithRuns(f.state, [observed]), true);
});

test('all valid views remain available at the edit ceiling while preserving accepted text and closure capacity', () => {
  const f = longWorkspace(true);
  const observed = textEvents(f.run, 'v'.repeat(4096));
  assert.equal(canAdmitConversationRun(f.state, observed), true);
  const base: DeskState = { ...f.state, selection: { goalId: null, sessionId: null, route: 'work' },
    preferences: { theme: 'dark', nexusView: 'atlas' } };
  const growth = serializedBytes(observed) - serializedBytes(f.run);
  const full = padTo(base, WORKSPACE_RUN_LIMIT_BYTES - 1024 - 4 * RESERVED_RUN_ACKNOWLEDGMENT_BYTES - growth - viewReserve(base));
  assert.equal(canSaveConversationWorkspaceWithRuns(full, [observed]), true);
  const tooLarge = padTo(full, serializedBytes(full) + 1);
  assert.equal(canSaveConversationWorkspaceWithRuns(tooLarge, [observed]), false, 'One extra edit byte crosses the reserved ceiling.');
  const commands: DeskCommand[] = [
    { type: 'select-session', sessionId: f.run.sessionId },
    { type: 'select-goal', goalId: full.goals[0].id },
    { type: 'select-ungrouped' },
    ...(['setup', 'sessions', 'work', 'memory', 'data'] as const).map((route): DeskCommand => ({ type: 'navigate', route })),
    ...(['navigator', 'canvas', 'atlas', 'roadmap'] as const).map((view): DeskCommand => ({ type: 'set-nexus-view', view })),
    ...(['system', 'light', 'dark'] as const).map((theme): DeskCommand => ({ type: 'set-theme', theme })),
  ];
  const before = JSON.stringify(full);
  // Exercise cumulative choices as well as the shortest-to-longest transition.
  let viewed = full;
  for (const command of commands) {
    assert.equal(isViewCommand(command), true);
    viewed = applyCommand(viewed, command);
    assert.equal(viewed.revision, full.revision, 'View changes do not advance content.');
    assert.equal(validateState(viewed).valid, true);
    assert.equal(canSaveConversationWorkspaceWithRuns(viewed, [observed]), true,
      `${command.type} remains available without consuming an accepted prefix's capacity.`);
    const saved = saveConversationRunCheckpoint(viewed, observed, f.run.lastSequence);
    assert.equal(serializedBytes(saved) + viewReserve(saved), WORKSPACE_RUN_LIMIT_BYTES - 1024 - 4 * RESERVED_RUN_ACKNOWLEDGMENT_BYTES);
    assert.deepEqual(saved.conversationRuns!.at(-1)!.outputChunks, observed.outputChunks);
    const completed = saveConversationRunCheckpoint(saved, event(observed, { type: 'completed' }), observed.lastSequence);
    assert.equal(canSaveConversationWorkspace(completed), true);
    assert.deepEqual(completed.conversationRuns!.at(-1)!.outputChunks, observed.outputChunks);
  }
  assert.equal(JSON.stringify(full), before, 'Budgeting and views never mutate saved work.');
});

test('legacy near-limit records remain readable without inventing room or deleting text to adopt the view reserve', () => {
  const f = longWorkspace(true);
  const base: DeskState = { ...f.state, selection: { goalId: null, sessionId: null, route: 'work' },
    preferences: { theme: 'dark' } };
  const legacy = padTo(base, WORKSPACE_RUN_LIMIT_BYTES - 1024);
  const before = JSON.stringify(legacy);
  assert.equal(canSaveConversationWorkspace(legacy), true, 'The previously valid saved record is still valid.');
  assert.equal(canSaveConversationWorkspaceWithRuns(legacy, []), false, 'Older records cannot acquire reserve by discarding data.');
  assert.equal(canSaveConversationWorkspaceWithRuns(applyCommand(legacy, { type: 'select-session', sessionId: f.run.sessionId }), []), false);
  assert.equal(JSON.stringify(captureConversationWorkspace(legacy)), before);
  assert.deepEqual(legacy.conversationRuns!.at(-1)!.outputChunks, f.run.outputChunks);
  // The App's separate, always-visible run controls keep Stop reachable while
  // navigation cannot be persisted safely; its conflict regression covers that.
});

test('checkpoint retains an accepted prefix after ordinary editing uses part of the streaming reserve', () => {
  const f = longWorkspace(true);
  const observed = textEvents(f.run, 'v'.repeat(4096));
  assert.equal(canAdmitConversationRun(f.state, observed), true);
  const edited = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - 1024 - 8192);
  const before = JSON.stringify(edited);
  assert.equal(canSaveConversationWorkspaceWithRuns(edited, [observed]), true);
  assert.equal(canAdmitConversationRun(edited, observed), false, 'new text admission still needs the streaming reserve');
  const saved = saveConversationRunCheckpoint(edited, observed, f.run.lastSequence);
  assert.deepEqual(saved.conversationRuns!.at(-1)!.outputChunks, observed.outputChunks);
  assert.equal(saved.conversationRuns!.at(-1)!.lastSequence, observed.lastSequence);
  assert.equal(saved.notes[0].body, edited.notes[0].body);
  assert.equal(saved.revision, edited.revision + 1);
  assert.equal(canSaveConversationWorkspace(saved, 1024), true);
  assert.equal(JSON.stringify(edited), before);
});

test('projected explicit closures release ordinary-edit headroom while retaining all unsaved text', () => {
  const f = longWorkspace(true);
  const observed = textEvents(f.run, 'v'.repeat(4096));
  const closure = closed(observed);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const difference = bytes(closure) - bytes(f.run);
  const edited = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - 4 * RESERVED_RUN_ACKNOWLEDGMENT_BYTES - difference - viewReserve(f.state));
  const before = JSON.stringify(edited);
  assert.equal(canSaveConversationWorkspaceWithRuns(edited, [closure]), true, 'closed projection keeps only the fixed acknowledgment allowance');
  assert.equal(canSaveConversationWorkspaceWithRuns(edited, [observed]), false, 'the same open projection still owes one closure');
  assert.equal(JSON.stringify(edited), before);
  assert.equal(edited.conversationRuns!.at(-1)!.closure, undefined, 'measurement is not a checkpoint');
  const saved = saveConversationRunCheckpoint(f.state, closure, f.run.lastSequence);
  const finishedEdit = padTo(saved, WORKSPACE_RUN_LIMIT_BYTES - 4 * RESERVED_RUN_ACKNOWLEDGMENT_BYTES - viewReserve(saved));
  assert.equal(canSaveConversationWorkspaceWithRuns(finishedEdit, []), true);
  assert.equal(canSaveConversationWorkspace(finishedEdit, RESERVED_RUN_RECOVERY_BYTES), false);
});

test('ordinary-edit projections refuse absent, duplicate, rewritten and rewound runs instead of preparing them', () => {
  const f = fixture();
  assert.equal(canSaveConversationWorkspaceWithRuns(f.state, [f.run]), false);
  assert.equal(f.state.schemaVersion, 1);
  const observed = textEvents(event(f.run, { type: 'started' }), 'Retain this text');
  const state = saveConversationRunCheckpoint(prepareConversationRun(f.state, f.run, f.draft), observed, 0);
  assert.equal(canSaveConversationWorkspaceWithRuns(state, [observed]), true);
  assert.equal(canSaveConversationWorkspaceWithRuns(state, [observed, observed]), false);
  assert.equal(canSaveConversationWorkspaceWithRuns(state, [f.run]), false);
  assert.equal(canSaveConversationWorkspaceWithRuns(state, [{ ...observed, runId: id(9999) }]), false);
  assert.equal(canSaveConversationWorkspaceWithRuns(state, [{ ...observed, inputChunks: ['Replaced input'] }]), false);
  assert.equal(canSaveConversationWorkspaceWithRuns(state, [{ ...observed, outputChunks: ['Replaced text'] }]), false);
});

test('ordinary-edit projection accounts for a pending checkpoint crossing a revision digit boundary without advancing state', () => {
  const f = longWorkspace(true);
  const closure = closed(f.run);
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const base = { ...f.state, revision: 9 };
  const difference = size(closure) - size(f.run);
  const edited = padTo(base, WORKSPACE_RUN_LIMIT_BYTES - 4 * RESERVED_RUN_ACKNOWLEDGMENT_BYTES - difference - viewReserve(base));
  assert.equal(canSaveConversationWorkspaceWithRuns(edited, [closure]), false, 'pending revision 10 costs one more byte');
  edited.notes[0].body = edited.notes[0].body.slice(0, -1);
  assert.equal(canSaveConversationWorkspaceWithRuns(edited, [closure]), true);
  assert.equal(edited.revision, 9);
});


test('legacy near-limit view navigation is reversible but cannot smuggle a content edit', () => {
  const f = longWorkspace(true);
  const base: DeskState = { ...f.state, selection: { goalId: f.state.goals[0].id, sessionId: f.state.sessions[0].id, route: 'sessions' },
    preferences: { theme: 'dark', nexusView: 'canvas' } };
  const legacy = padTo(base, WORKSPACE_RUN_LIMIT_BYTES - 1024);
  assert.equal(canSaveConversationWorkspaceWithRuns(legacy, []), false);
  const theme = applyCommand(legacy, { type: 'set-theme', theme: 'light' });
  assert.equal(canSaveConversationWorkspaceWithRuns(theme, [], legacy), true, 'A view may use actual native room without creating a reserve retroactively.');
  const viewed = applyCommand(legacy, { type: 'set-nexus-view', view: 'atlas' });
  assert.equal(canSaveConversationWorkspaceWithRuns(viewed, [], legacy), true);
  const smaller = applyCommand(viewed, { type: 'navigate', route: 'data' });
  assert.equal(canSaveConversationWorkspaceWithRuns(smaller, [], viewed), true);
  const back = applyCommand(smaller, { type: 'navigate', route: 'sessions' });
  assert.equal(canSaveConversationWorkspaceWithRuns(back, [], smaller), true, 'Returning to the longer conversation route is allowed.');
  assert.deepEqual(back, viewed);
  const ungrouped = applyCommand(back, { type: 'select-ungrouped' });
  assert.equal(canSaveConversationWorkspaceWithRuns(ungrouped, [], back), true);
  const selected = applyCommand(ungrouped, { type: 'select-session', sessionId: f.run.sessionId });
  assert.equal(canSaveConversationWorkspaceWithRuns(selected, [], ungrouped), true, 'Null selections can grow back to UUID selections.');
  assert.deepEqual(selected, { ...back, preferences: { ...back.preferences, nexusView: 'navigator' } });
  const changed = structuredClone(viewed);
  changed.notes[0].body = changed.notes[0].body.slice(0, -1) + 'z';
  assert.equal(canSaveConversationWorkspaceWithRuns(changed, [], legacy), false, 'Size-neutral content edits are not navigation.');
  assert.equal(canSaveConversationWorkspaceWithRuns(viewed, [{ ...f.run, outputChunks: ['forged'] }], legacy), false);
  assert.deepEqual(viewed.conversationRuns, legacy.conversationRuns);
});

test('closed terminal may gain one cleanup acknowledgment without changing or losing its outcome', () => {
  const f = fixture();
  const open = prepareConversationRun(f.state, f.run, f.draft);
  const terminal = appendParticipantEvent(f.run, { type: 'failed', reason: 'stop-incomplete',
    runId: f.run.runId, sessionId: f.run.sessionId, sequence: 1, at: newest });
  assert.equal(terminal.kind, 'ok');
  if (terminal.kind !== 'ok') return;
  const saved = saveConversationRunCheckpoint(open, terminal.run, 0);
  const choice = acknowledgeUnreachableCleanup(terminal.run, newest);
  assert.equal(choice.kind, 'ok');
  if (choice.kind !== 'ok') return;
  assert.equal(canAdmitConversationRun(saved, choice.run), true);
  const next = saveConversationRunCheckpoint(saved, choice.run, terminal.run.lastSequence);
  assert.equal(next.revision, saved.revision + 1);
  assert.deepEqual(next.conversationRuns![0], choice.run);
  assert.equal(next.conversationRuns![0].reason, 'stop-incomplete');
  assert.equal(saveConversationRunCheckpoint(next, choice.run, 1), next);
  reject(() => saveConversationRunCheckpoint(next, terminal.run, 1));
  reject(() => saveConversationRunCheckpoint(next, { ...choice.run, cleanupAcknowledgment: { kind: 'unreachable', at: '2026-10-10T00:00:00.000Z' } }, 1));
  reject(() => saveConversationRunCheckpoint(saved, { ...choice.run, reason: 'local-stop' }, 1));
});


test('closed replies retain acknowledgment room even when ordinary work fills the workspace', () => {
  for (const reason of [undefined, 'stop-incomplete'] as const) {
    const f = longWorkspace();
    f.state = structuredClone(f.state);
    const last = f.state.conversationRuns!.at(-1)!;
    if (reason) { last.phase = 'failed'; last.reason = reason; }
    const reserve = f.state.conversationRuns!.length * RESERVED_RUN_ACKNOWLEDGMENT_BYTES;
    const full = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - viewReserve(f.state) - reserve);
    assert.equal(canSaveConversationWorkspaceWithRuns(full, []), true);
    assert.equal(canSaveConversationWorkspaceWithRuns(padTo(full, serializedBytes(full) + 1), []), false,
      'An ordinary edit must leave each fixed acknowledgment allowance intact.');
    const before = JSON.stringify(full);
    const choice = acknowledgeUnreachableCleanup(last, newest);
    assert.equal(choice.kind, 'ok');
    if (choice.kind !== 'ok') return;
    assert.ok(serializedBytes(choice.run) - serializedBytes(last) < RESERVED_RUN_ACKNOWLEDGMENT_BYTES);
    assert.equal(canAdmitConversationRun(full, choice.run), true);
    const saved = saveConversationRunCheckpoint(full, choice.run, last.lastSequence);
    assert.deepEqual(saved.conversationRuns!.at(-1), choice.run);
    assert.equal(canSaveConversationWorkspaceWithRuns(saved, []), true,
      "Saving one acknowledgment retains the others' allowances.");
    assert.equal(JSON.stringify(full), before);
  }
});

test('legacy full records refuse an acknowledgment before mutation rather than inventing room', () => {
  const f = longWorkspace();
  const full = padTo(f.state, WORKSPACE_RUN_LIMIT_BYTES - viewReserve(f.state));
  const last = full.conversationRuns!.at(-1)!;
  const before = JSON.stringify(full);
  const choice = acknowledgeUnreachableCleanup(last, newest);
  assert.equal(choice.kind, 'ok');
  if (choice.kind !== 'ok') return;
  assert.equal(canSaveConversationWorkspace(full), true);
  assert.equal(canAdmitConversationRun(full, choice.run), false,
    'Callers can show the capacity refusal and retain the retry before marking the choice pending.');
  reject(() => saveConversationRunCheckpoint(full, choice.run, last.lastSequence));
  assert.equal(JSON.stringify(full), before);
});

test('legacy view exception never exceeds the actual native ceiling or hides projected text growth', () => {
  const f = longWorkspace(true);
  const base = { ...f.state, preferences: { theme: 'dark' as const, nexusView: 'canvas' as const } };
  const full = padTo(base, WORKSPACE_RUN_LIMIT_BYTES);
  const longer = applyCommand(full, { type: 'set-theme', theme: 'light' });
  assert.equal(canSaveConversationWorkspaceWithRuns(longer, [], full), false);
  const smaller = applyCommand(full, { type: 'navigate', route: 'data' });
  assert.equal(canSaveConversationWorkspaceWithRuns(smaller, [], full), true);
  const back = applyCommand(smaller, { type: 'navigate', route: full.selection.route });
  assert.equal(canSaveConversationWorkspaceWithRuns(back, [], smaller), true);
  const unsaved = event(f.run, { type: 'text', text: 'new prefix' });
  assert.equal(canSaveConversationWorkspaceWithRuns(smaller, [unsaved], full), false);
});

test('an atomic closure with an acknowledgment retains the unsaved prefix and exact interrupted terminal', () => {
  const f = fixture();
  const started = event(f.run, { type: 'started' });
  const saved = saveConversationRunCheckpoint(prepareConversationRun(f.state, f.run, f.draft), started, 0);
  const observed = textEvents(started, 'Tail observed after the saved checkpoint');
  const at = '2026-10-09T16:33:00.000Z';
  const closure = closeConversationRun(observed, { kind: 'interrupted', reason: 'event-refused', at,
    terminalEvent: { type: 'stopped', reason: 'local-stop', runId: observed.runId,
      sessionId: observed.sessionId, sequence: observed.lastSequence + 2, at } });
  assert.equal(closure.kind, 'ok');
  if (closure.kind !== 'ok') return;
  const choice = acknowledgeUnreachableCleanup(closure.run, at);
  assert.equal(choice.kind, 'ok');
  if (choice.kind !== 'ok') return;
  assert.equal(canAdmitConversationRun(saved, choice.run), true);
  const next = saveConversationRunCheckpoint(saved, choice.run, started.lastSequence);
  assert.deepEqual(next.conversationRuns![0], choice.run);
  assert.equal(next.conversationRuns![0].outputChunks.join(''), observed.outputChunks.join(''));
  assert.equal(validateState(next).valid, true);
});

test('loaded cleanup acknowledgment time cannot exceed its workspace time', () => {
  const f = fixture();
  const completed = event(event(f.run, { type: 'started' }), { type: 'completed' });
  const saved = saveConversationRunCheckpoint(prepareConversationRun(f.state, f.run, f.draft), completed, 0);
  const at = '2026-10-09T16:33:00.000Z';
  const choice = acknowledgeUnreachableCleanup(completed, at);
  assert.equal(choice.kind, 'ok');
  if (choice.kind !== 'ok') return;
  assert.equal(validateConversationRun(choice.run), true);
  assert.equal(validateState({ ...saved, conversationRuns: [choice.run] }).valid, false);
  assert.equal(validateState({ ...saved, updatedAt: at, conversationRuns: [choice.run] }).valid, true);
  const next = saveConversationRunCheckpoint(saved, choice.run, completed.lastSequence);
  assert.equal(next.updatedAt, at);
  assert.equal(validateState(JSON.parse(JSON.stringify(next))).valid, true);
});

test('replay-lost prefix and exact loss evidence survive save/reopen; later acknowledgments cannot rewrite the loss reason', async () => {
  const f = fixture();
  const prepared = prepareConversationRun(f.state, f.run, f.draft);
  const observed = event(event(f.run, { type: 'started' }), { type: 'text', text: 'Literal partial reply.' });
  const closedAt = '2026-10-09T16:33:00.000Z';
  const closure = closeConversationRun(observed, { kind: 'interrupted', reason: 'replay-lost', at: closedAt,
    terminalEvent: { type: 'completed', runId: f.run.runId, sessionId: f.run.sessionId, sequence: 6, at: closedAt },
    lost: { fromSequence: 3, throughSequence: 5, reason: 'restarted' } });
  assert.equal(closure.kind, 'ok');
  if (closure.kind !== 'ok') throw Error('closure fixture');
  const saved = saveConversationRunCheckpoint(prepared, closure.run, 0);
  assert.equal(saved.updatedAt, closedAt);
  assert.equal(saved.conversationRuns![0].lastSequence, 2);
  assert.equal(saved.conversationRuns![0].outputChunks.join(''), 'Literal partial reply.');
  let savedBytes: string | null = null;
  const repository = new BrowserRepository({ getItem: () => savedBytes, setItem: (_key, value) => { savedBytes = value; } },
    async (operation) => operation());
  assert.equal((await repository.save(saved, null)).kind, 'saved');
  const reopened = repository.load();
  assert.equal(reopened.kind, 'ready');
  if (reopened.kind !== 'ready') throw Error('reopen fixture');
  assert.deepEqual(reopened.state.conversationRuns, [closure.run]);
  const altered = JSON.parse(JSON.stringify(closure.run)) as ConversationRun;
  if (altered.closure?.kind !== 'interrupted' || altered.closure.reason !== 'replay-lost') throw Error('loss fixture');
  altered.closure.lost.reason = 'locked';
  assert.equal(validateConversationRun(altered), true, 'a standalone valid claim is still different saved evidence');
  reject(() => saveConversationRunCheckpoint(reopened.state, altered, altered.lastSequence));
  const acknowledged = acknowledgeUnreachableCleanup(altered, '2026-10-09T16:34:00.000Z');
  assert.equal(acknowledged.kind, 'ok');
  if (acknowledged.kind !== 'ok') throw Error('ack fixture');
  reject(() => saveConversationRunCheckpoint(reopened.state, acknowledged.run, altered.lastSequence));
  assert.deepEqual(repository.load(), reopened);
});
