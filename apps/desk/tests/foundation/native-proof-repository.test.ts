import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NATIVE_PROOF_LIMITS, NativeProofCodec, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';
import { NativeProofRepository } from '../../src/adapters/native-proof-repository';
import type { DeskState } from '../../src/domain/types';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-host-v1.json', import.meta.url), 'utf8')) as {
  context: { connectionId: string; documentGeneration: number };
  cases: { name: string; request: { payload: Record<string, unknown> }; reply: Record<string, unknown> }[];
};
const context = fixture.context;
const reading = fixture.cases.find((entry) => entry.name === 'workspace.read')!;
const record = () => structuredClone(reading.reply.record) as DeskState;
const changed = () => {
  const value = record();
  value.revision = 3;
  value.drafts[value.sessions[0].id] = 'Invented attempted draft.';
  return value;
};

class Transport implements NativeHostTransport {
  readonly wires: string[] = [];
  reply = (_wire: string) => {};
  revoked = () => {};
  onSend?: () => void | Promise<void>;
  listen(reply: (wire: string) => void, revoked: () => void) {
    this.reply = reply;
    this.revoked = revoked;
    return () => {};
  }
  send(wire: string) { this.wires.push(wire); return this.onSend?.(); }
  answer(index: number, result: Record<string, unknown>) {
    const { payload: _payload, ...base } = JSON.parse(this.wires[index]);
    this.reply(JSON.stringify({ ...base, ...result }));
  }
}

function setup(factory?: () => string, onRevoked?: () => void) {
  const transport = new Transport();
  const codec = new NativeProofCodec(context, 30);
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec, {
    ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 30, timeoutMs: 100,
  });
  let identities = 0;
  const repository = new NativeProofRepository(client, reading.request.payload.workspaceHandle as string, factory ?? (() => {
    identities++;
    return `81000000-0000-4000-8000-${identities.toString().padStart(12, '0')}`;
  }), onRevoked);
  const close = () => { repository.revoke(); client.revoke(); codec.revoke(); };
  return { repository, transport, client, codec, close, identityCount: () => identities };
}

test('native repository reads only the injected issued handle and returns an independent valid snapshot', async () => {
  const { repository, transport, close } = setup();
  const pending = repository.loadLatest();
  const request = JSON.parse(transport.wires[0]);
  assert.equal(request.operation, 'workspace.read');
  assert.deepEqual(request.payload, { workspaceHandle: reading.request.payload.workspaceHandle });
  transport.answer(0, { outcome: 'ok', revision: 1, record: record() });
  const loaded = await pending;
  assert.equal(loaded.kind, 'ready');
  if (loaded.kind === 'ready') {
    assert.deepEqual(loaded.state, record());
    loaded.state.drafts[loaded.state.sessions[0].id] = 'Later local text';
    assert.equal(record().drafts[record().sessions[0].id], 'Before 😀 after');
  }
  close();
});

test('missing, corrupt, locked and failed native reads never return empty or initialize a replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['store-missing', 'store-corrupt', 'store-locked', 'unknown-handle']) {
    const { repository, transport, close } = setup();
    const pending = repository.loadLatest();
    transport.answer(0, { outcome: 'refused', reason });
    const result = await pending;
    assert.equal(result.kind, 'unavailable');
    assert.deepEqual(Object.keys(result).sort(), ['error', 'kind']);
    assert.equal(transport.wires.length, 1);
    close();
  }
  const { repository, transport, close } = setup();
  const pending = repository.loadLatest();
  t.mock.timers.tick(100);
  assert.equal((await pending).kind, 'unavailable');
  assert.equal(transport.wires.length, 1);
  close();
});

test('save captures the immutable snapshot, expected revision and request identity before awaiting native durability', async () => {
  const { repository, transport, close, identityCount } = setup();
  const state = changed();
  const before = structuredClone(state);
  const pending = repository.save(state, 1);
  state.revision = 4;
  state.drafts[state.sessions[0].id] = 'Newer unsaved edit';
  const wire = JSON.parse(transport.wires[0]);
  assert.equal(wire.operation, 'workspace.commitProof');
  assert.equal(wire.payload.expectedRevision, 1);
  assert.deepEqual(wire.payload.record, before);
  assert.equal(identityCount(), 1);
  transport.answer(0, { outcome: 'ok', revision: 3 });
  assert.deepEqual(await pending, { kind: 'saved', state: before });
  assert.equal(state.drafts[state.sessions[0].id], 'Newer unsaved edit');
  close();
});

test('invalid, missing or nonadvancing expected revisions refuse without dispatch or initialization', async () => {
  const { repository, transport, close, identityCount } = setup();
  for (const revision of [null, -1, 1.5, 3, 4, Number.MAX_SAFE_INTEGER + 1]) {
    const state = changed();
    const result = await repository.save(state, revision);
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.deepEqual(result.attemptedState, state);
  }
  const invalid = changed();
  invalid.sessions[0].goalId = 'missing';
  assert.equal((await repository.save(invalid, 1)).kind, 'failed');
  assert.equal(identityCount(), 0);
  assert.equal(transport.wires.length, 0);
  close();
});

test('bad UUID generation refuses before host dispatch and does not expose an exception payload', async () => {
  for (const factory of [() => 'bad-id', () => { throw new Error('Private exception canary'); }]) {
    const { repository, transport, close } = setup(factory);
    const failed = await repository.save(changed(), 1);
    assert.equal(failed.kind, 'failed');
    assert.equal(JSON.stringify(failed).includes('Private exception canary'), false);
    assert.equal((await repository.loadLatest()).kind, 'unavailable');
    assert.equal(transport.wires.length, 0);
    close();
  }
});

test('conflict keeps the attempted state separate and sends no replacement or automatic retry', async () => {
  const { repository, transport, close } = setup();
  const state = changed();
  const pending = repository.save(state, 1);
  transport.answer(0, { outcome: 'conflict', revision: 5, reason: 'revision-mismatch' });
  const result = await pending;
  assert.equal(result.kind, 'conflict');
  if (result.kind === 'conflict') {
    assert.deepEqual(result.attemptedState, state);
    assert.equal(result.currentState, undefined, 'A revision is not a current-state snapshot.');
  }
  assert.equal(transport.wires.length, 1);
  assert.equal((await repository.reconcilePending()).kind, 'unavailable');
  close();
});

test('unknown saves block later snapshots and reconcile only the original request bytes and identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { repository, transport, close, identityCount } = setup();
  const original = changed();
  const pending = repository.save(original, 1);
  const firstWire = transport.wires[0];
  const later = changed();
  later.revision = 7;
  later.drafts[later.sessions[0].id] = 'Later work must not replace the uncertain original.';
  assert.strictEqual(repository.save(later, 1), pending);
  transport.answer(0, { outcome: 'unknown' });
  t.mock.timers.tick(100);
  const unknown = await pending;
  assert.equal(unknown.kind, 'unknown');
  if (unknown.kind !== 'unknown') throw new Error('Expected an unknown outcome');
  assert.equal(unknown.requestId, JSON.parse(firstWire).requestId);
  unknown.attemptedState.drafts[unknown.attemptedState.sessions[0].id] = 'Caller mutation cannot change reconciliation';
  const blocked = await repository.save(later, 1);
  assert.equal(blocked.kind, 'unknown');
  if (blocked.kind === 'unknown') assert.deepEqual(blocked.attemptedState, original);
  assert.equal(identityCount(), 1);
  assert.equal(transport.wires.length, 1);
  const reconciliation = repository.reconcilePending();
  assert.equal(transport.wires.length, 2);
  assert.equal(transport.wires[1], firstWire);
  assert.equal(identityCount(), 1);
  transport.answer(1, { outcome: 'ok', revision: 3 });
  assert.deepEqual(await reconciliation, { kind: 'saved', state: original });
  close();
});

test('wrong-revision success and receipt-like replies cannot claim a saved workspace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { repository, transport, close } = setup();
  const pending = repository.save(changed(), 1);
  transport.answer(0, { outcome: 'ok', revision: 2 });
  transport.answer(0, { outcome: 'ok', receipt: 'received' });
  t.mock.timers.tick(100);
  assert.equal((await pending).kind, 'unknown');
  assert.equal(transport.wires.length, 1);
  close();
});

test('late durable result reconciles from the same client cache without resending or generating an ID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { repository, transport, close, identityCount } = setup();
  const pending = repository.save(changed(), 1);
  t.mock.timers.tick(100);
  assert.equal((await pending).kind, 'unknown');
  transport.answer(0, { outcome: 'ok', revision: 3 });
  assert.equal((await repository.reconcilePending()).kind, 'saved');
  assert.equal(transport.wires.length, 1);
  assert.equal(identityCount(), 1);
  close();
});

test('transport failure remains unknown until explicit same-request reconciliation', async () => {
  const { repository, transport, close } = setup();
  transport.onSend = () => { throw new Error('Private transport detail'); };
  const result = await repository.save(changed(), 1);
  assert.equal(result.kind, 'unknown');
  assert.equal(JSON.stringify(result).includes('Private transport detail'), false);
  const firstWire = transport.wires[0];
  transport.onSend = undefined;
  const pending = repository.reconcilePending();
  assert.equal(transport.wires[1], firstWire);
  transport.answer(1, { outcome: 'ok', revision: 3 });
  assert.equal((await pending).kind, 'saved');
  close();
});

test('revocation settles pending reads and saves without attempted text and ignores late native success', async () => {
  const { repository, transport, client, codec, identityCount } = setup();
  let notifications = 0;
  repository.subscribe(() => { throw new Error('Subscriber failure'); });
  repository.subscribe(() => { notifications++; });
  const load = repository.loadLatest();
  const save = repository.save(changed(), 1);
  repository.revoke();
  assert.equal((await load).kind, 'unavailable');
  const saved = await save;
  assert.equal(saved.kind, 'unavailable');
  assert.deepEqual(Object.keys(saved).sort(), ['error', 'kind']);
  transport.answer(0, { outcome: 'ok', revision: 1, record: record() });
  transport.answer(1, { outcome: 'ok', revision: 3 });
  assert.equal((await repository.loadLatest()).kind, 'unavailable');
  assert.equal((await repository.save(changed(), 1)).kind, 'unavailable');
  assert.equal((await repository.reconcilePending()).kind, 'unavailable');
  repository.revoke();
  assert.equal(notifications, 1);
  assert.equal(identityCount(), 2);
  assert.equal(transport.wires.length, 2);
  client.revoke();
  codec.revoke();
});

test('native lock refusal and client revocation close the repository with no retained-state result', async () => {
  for (const mode of ['locked', 'revoked']) {
    const { repository, transport, close } = setup();
    const pending = repository.save(changed(), 1);
    if (mode === 'locked') transport.answer(0, { outcome: 'refused', reason: 'store-locked' });
    else transport.revoked();
    const result = await pending;
    assert.equal(result.kind, 'unavailable');
    assert.deepEqual(Object.keys(result).sort(), ['error', 'kind']);
    assert.equal((await repository.save(changed(), 1)).kind, 'unavailable');
    assert.equal(transport.wires.length, 1);
    close();
  }
});

test('repository revocation notifies its owner once after closing pending work and tolerates recursive cleanup', async () => {
  let notifications = 0;
  let afterRevocation: ReturnType<NativeProofRepository['reconcilePending']> | undefined;
  const { repository, transport, close } = setup(undefined, () => {
    ++notifications;
    afterRevocation = repository.reconcilePending();
    repository.revoke();
    throw new Error('Invented cleanup failure must not escape');
  });
  const read = repository.loadLatest();
  const save = repository.save(changed(), 1);
  assert.doesNotThrow(() => repository.revoke());
  for (const result of await Promise.all([read, save, afterRevocation])) {
    assert.equal(result?.kind, 'unavailable');
    assert.deepEqual(Object.keys(result!).sort(), ['error', 'kind']);
  }
  assert.equal(notifications, 1);
  assert.equal(transport.wires.length, 2);
  close();
  assert.equal(notifications, 1);
});
