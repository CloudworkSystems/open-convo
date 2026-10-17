import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NATIVE_PROOF_LIMITS, NativeProofCodec, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';
import { NativeProofRepository } from '../../src/adapters/native-proof-repository';
import type { ConversationRun } from '../../src/domain/conversation-run-types';
import { appendParticipantEvent, createConversationRun } from '../../src/domain/conversation-runs';
import type { DeskState } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-host-v1.json', import.meta.url), 'utf8')) as {
  context: { connectionId: string; documentGeneration: number };
  cases: { name: string; request: { payload: Record<string, unknown> }; reply: Record<string, unknown> }[];
};
const reading = fixture.cases.find((entry) => entry.name === 'workspace.read')!;
const context = fixture.context;
const at = '2026-10-10T12:00:00.000Z';
const id = (number: number) => `85000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const record = () => structuredClone(reading.reply.record) as DeskState;
function run(sessionId: string, number = 10): ConversationRun {
  const result = createConversationRun({ runId: id(number), sessionId, userMessageId: id(number + 1), assistantMessageId: id(number + 2),
    participant: { id: 'invented-native-participant', label: 'Invented participant', model: 'invented-model', executionHost: 'invented-host' },
    input: '  Complete invented input 🧪\n', createdAt: at });
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Expected a valid invented run');
  return structuredClone(result.run);
}
function withRun(base = record(), number = 10): DeskState {
  const state = structuredClone(base);
  state.schemaVersion = 2;
  state.revision += 2;
  state.updatedAt = at;
  state.capabilities.provider = 'runtime-selected';
  state.conversationRuns = [...(state.conversationRuns ?? []), run(state.sessions.at(-1)!.id, number)];
  assert.equal(validateState(state).valid, true);
  return state;
}
function edited(base: DeskState): DeskState {
  const state = structuredClone(base);
  state.revision++;
  state.drafts[state.sessions[0].id] = 'Newer complete invented draft retained separately.';
  assert.equal(validateState(state).valid, true);
  return state;
}
function claim(value: ConversationRun) {
  return { runId: value.runId, sessionId: value.sessionId, userMessageId: value.userMessageId,
    assistantMessageId: value.assistantMessageId, participantId: value.participant.id, createdAt: value.createdAt };
}
function secondSession(state: DeskState): DeskState {
  state = structuredClone(state);
  state.sessions.push({ ...state.sessions[0], id: id(500), title: 'Another invented session' });
  state.drafts[id(500)] = 'Another complete invented draft.';
  return state;
}
class Transport implements NativeHostTransport {
  readonly wires: string[] = [];
  reply = (_wire: string) => {};
  listen(reply: (wire: string) => void, _revoked: () => void) { this.reply = reply; return () => {}; }
  send(wire: string) { this.wires.push(wire); }
  answer(index: number, result: Record<string, unknown>) {
    const { payload: _payload, ...base } = JSON.parse(this.wires[index]);
    this.reply(JSON.stringify({ ...base, ...result }));
  }
}
function setup() {
  const transport = new Transport();
  const codec = new NativeProofCodec(context, 30);
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec, {
    ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 30, timeoutMs: 100,
  });
  let next = 0;
  const repository = new NativeProofRepository(client, reading.request.payload.workspaceHandle as string,
    () => id(1000 + ++next), undefined, { participants: true });
  const read = async (state: DeskState) => {
    const index = transport.wires.length;
    const pending = repository.loadLatest();
    transport.answer(index, { outcome: 'ok', revision: state.revision, record: state });
    const result = await pending;
    assert.equal(result.kind, 'ready');
    return result;
  };
  const close = () => { repository.revoke(); client.revoke(); codec.revoke(); };
  return { repository, transport, read, close, identities: () => next };
}

test('participant save refuses without a validated baseline and preserves the complete attempt without dispatch', async () => {
  const f = setup();
  try {
    const attempted = withRun();
    const failed = await f.repository.save(attempted, 1);
    assert.equal(failed.kind, 'failed');
    if (failed.kind === 'failed') assert.deepEqual(failed.attemptedState, attempted);
    assert.equal(f.identities(), 0);
    assert.equal(f.transport.wires.length, 0);
  } finally { f.close(); }
});

test('ordinary native preparation captures exactly one claim and later checkpoints do not prepare it again', async () => {
  const f = setup();
  try {
    await f.read(record());
    const attempted = withRun();
    const captured = structuredClone(attempted);
    const saved = f.repository.save(attempted, 1);
    const request = JSON.parse(f.transport.wires[1]);
    assert.deepEqual(request.payload.participantRun, claim(captured.conversationRuns![0]));
    assert.deepEqual(Object.keys(request.payload).sort(), ['expectedRevision', 'participantRun', 'record', 'workspaceHandle']);
    assert.deepEqual(request.payload.record, captured);
    attempted.conversationRuns![0].inputChunks[0] = 'Later mutation cannot replace input';
    f.transport.answer(1, { outcome: 'ok', revision: captured.revision });
    assert.deepEqual(await saved, { kind: 'saved', state: captured });

    const checkpoint = edited(captured);
    const started = appendParticipantEvent(checkpoint.conversationRuns![0], {
      runId: captured.conversationRuns![0].runId, sessionId: captured.sessions[0].id, sequence: 1, at, type: 'started',
    });
    assert.equal(started.kind, 'ok');
    if (started.kind !== 'ok') throw new Error('Expected started checkpoint');
    checkpoint.conversationRuns![0] = started.run;
    const pending = f.repository.save(checkpoint, captured.revision);
    assert.equal(Object.hasOwn(JSON.parse(f.transport.wires[2]).payload, 'participantRun'), false);
    f.transport.answer(2, { outcome: 'ok', revision: checkpoint.revision });
    assert.equal((await pending).kind, 'saved');
  } finally { f.close(); }
});

test('loaded runs establish the baseline without treating their read as new preparation', async () => {
  const f = setup();
  try {
    const existing = withRun();
    const loaded = await f.read(existing);
    if (loaded.kind === 'ready') loaded.state.conversationRuns = [];
    const next = edited(existing);
    const pending = f.repository.save(next, existing.revision);
    assert.equal(Object.hasOwn(JSON.parse(f.transport.wires[1]).payload, 'participantRun'), false);
    f.transport.answer(1, { outcome: 'ok', revision: next.revision });
    assert.equal((await pending).kind, 'saved');
  } finally { f.close(); }
});

test('multiple introduced runs, a nonprepared run, and a prepared local closure refuse before dispatch', async () => {
  for (const mode of ['multiple', 'running', 'closure']) {
    const f = setup();
    try {
      await f.read(record());
      let attempted = withRun();
      if (mode === 'multiple') attempted = withRun(secondSession(attempted), 20);
      if (mode === 'running') {
        const result = appendParticipantEvent(attempted.conversationRuns![0], {
          runId: attempted.conversationRuns![0].runId, sessionId: attempted.sessions[0].id, sequence: 1, at, type: 'started',
        });
        assert.equal(result.kind, 'ok');
        if (result.kind === 'ok') attempted.conversationRuns![0] = result.run;
      }
      if (mode === 'closure') attempted.conversationRuns![0].closure = { kind: 'unknown', reason: 'user-closed', at };
      assert.equal(validateState(attempted).valid, true);
      const failed = await f.repository.save(attempted, 1);
      assert.equal(failed.kind, 'failed', mode);
      if (failed.kind === 'failed') assert.deepEqual(failed.attemptedState, attempted);
      assert.equal(f.transport.wires.length, 1);
      assert.equal(f.identities(), 1);
    } finally { f.close(); }
  }
});

test('known refusal preserves the old baseline and global Retry derives the same new-run claim under a fresh request', async () => {
  const f = setup();
  try {
    const base = secondSession(withRun());
    await f.read(base);
    const attempted = withRun(base, 20);
    const first = f.repository.save(attempted, base.revision);
    const original = JSON.parse(f.transport.wires[1]);
    f.transport.answer(1, { outcome: 'refused', reason: 'store-corrupt' });
    const failed = await first;
    assert.equal(failed.kind, 'failed');
    if (failed.kind !== 'failed') throw new Error('Expected a retained failed attempt');
    assert.deepEqual(failed.attemptedState, attempted);
    const retried = f.repository.save(failed.attemptedState, base.revision);
    const retry = JSON.parse(f.transport.wires[2]);
    assert.notEqual(retry.requestId, original.requestId);
    assert.deepEqual(retry.payload, original.payload);
    assert.deepEqual(retry.payload.participantRun, claim(attempted.conversationRuns![1]));
    f.transport.answer(2, { outcome: 'ok', revision: attempted.revision });
    assert.equal((await retried).kind, 'saved');
  } finally { f.close(); }
});

test('unknown preparation reconciles identical bytes even after a native read observes its committed run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup();
  try {
    await f.read(record());
    const original = withRun();
    const pending = f.repository.save(original, 1);
    const originalWire = f.transport.wires[1];
    t.mock.timers.tick(100);
    const unknown = await pending;
    assert.equal(unknown.kind, 'unknown');
    if (unknown.kind === 'unknown') unknown.attemptedState.conversationRuns![0].inputChunks[0] = 'Caller mutation';
    await f.read(original);
    const blocked = await f.repository.save(edited(original), original.revision);
    assert.equal(blocked.kind, 'unknown');
    assert.equal(f.transport.wires.length, 3);
    const reconciled = f.repository.reconcilePending();
    assert.equal(f.transport.wires[3], originalWire, 'No rebuilt claim or new request identity during reconciliation');
    f.transport.answer(3, { outcome: 'ok', revision: original.revision });
    assert.deepEqual(await reconciled, { kind: 'saved', state: original });
    const next = edited(original);
    const saved = f.repository.save(next, original.revision);
    assert.equal(Object.hasOwn(JSON.parse(f.transport.wires[4]).payload, 'participantRun'), false);
    f.transport.answer(4, { outcome: 'ok', revision: next.revision });
    assert.equal((await saved).kind, 'saved');
  } finally { f.close(); }
});

test('a stale in-flight read cannot roll back the baseline established by durable preparation', async () => {
  const f = setup();
  try {
    await f.read(record());
    const oldRead = f.repository.loadLatest();
    const prepared = withRun();
    const save = f.repository.save(prepared, 1);
    f.transport.answer(2, { outcome: 'ok', revision: prepared.revision });
    assert.equal((await save).kind, 'saved');
    f.transport.answer(1, { outcome: 'ok', revision: 1, record: record() });
    assert.equal((await oldRead).kind, 'ready');
    const next = edited(prepared);
    const pending = f.repository.save(next, prepared.revision);
    assert.equal(Object.hasOwn(JSON.parse(f.transport.wires[3]).payload, 'participantRun'), false);
    f.transport.answer(3, { outcome: 'ok', revision: next.revision });
    assert.equal((await pending).kind, 'saved');
  } finally { f.close(); }
});

test('out-of-order reads and stale expected revisions cannot lose known runs or allocate a stale save', async () => {
  const f = setup();
  try {
    const older = f.repository.loadLatest();
    const newer = f.repository.loadLatest();
    const prepared = withRun();
    f.transport.answer(1, { outcome: 'ok', revision: prepared.revision, record: prepared });
    assert.equal((await newer).kind, 'ready');
    f.transport.answer(0, { outcome: 'ok', revision: 1, record: record() });
    assert.equal((await older).kind, 'ready');
    const stale = await f.repository.save(withRun(), 1);
    assert.equal(stale.kind, 'failed');
    assert.equal(f.transport.wires.length, 2);
    assert.equal(f.identities(), 2);
    const next = edited(prepared);
    const saved = f.repository.save(next, prepared.revision);
    assert.equal(Object.hasOwn(JSON.parse(f.transport.wires[2]).payload, 'participantRun'), false);
    f.transport.answer(2, { outcome: 'ok', revision: next.revision });
    assert.equal((await saved).kind, 'saved');
  } finally { f.close(); }
});

// Step 3 PR 4b: a local model's prepared run has `contextRunIds` (contract
// section 20.3). Before this fix the repository refused it before dispatch,
// so a local run was never prepared on the Mac.
test('a local prepared run with its context ids is claimed; a Claude run with them, or a local run without, is refused', async () => {
  const f = setup();
  try {
    await f.read(record());
    const base = record();
    const localRun = (context: boolean) => {
      const result = createConversationRun({ runId: id(40), sessionId: base.sessions.at(-1)!.id, userMessageId: id(41), assistantMessageId: id(42),
        participant: { id: 'ollama-local', label: 'invented-local:8b', model: `invented-local:8b@${'b'.repeat(64)}`, executionHost: 'this-mac' },
        input: 'Invented local question.', createdAt: at, ...(context ? { contextRunIds: [] } : {}) });
      assert.equal(result.kind, 'ok');
      if (result.kind !== 'ok') throw new Error('Expected a valid invented run');
      const state = structuredClone(base);
      state.schemaVersion = 2; state.revision += 2; state.updatedAt = at; state.capabilities.provider = 'runtime-selected';
      state.conversationRuns = [structuredClone(result.run)];
      return state;
    };
    const withoutContext = localRun(true);
    delete withoutContext.conversationRuns![0].contextRunIds;
    const claudeWithContext = localRun(true);
    claudeWithContext.conversationRuns![0].participant.id = 'claude-code';
    for (const [attempt, why] of [[withoutContext, 'local without context ids'], [claudeWithContext, 'Claude with context ids']] as const) {
      if (!validateState(attempt).valid) continue;
      assert.equal((await f.repository.save(attempt, 1)).kind, 'failed', why);
    }
    assert.equal(f.transport.wires.length, 1, 'nothing dispatched for the refused shapes');
    const attempted = localRun(true);
    assert.equal(validateState(attempted).valid, true);
    const saved = f.repository.save(attempted, 1);
    const request = JSON.parse(f.transport.wires[1]);
    assert.deepEqual(request.payload.participantRun, claim(attempted.conversationRuns![0]));
    assert.equal(request.payload.participantRun.participantId, 'ollama-local');
    f.transport.answer(1, { outcome: 'ok', revision: attempted.revision });
    assert.equal((await saved).kind, 'saved');
  } finally { f.close(); }
});
