import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeDictationLane, type DictationFinal } from '../../src/adapters/native-dictation';
import { NativeHostClient } from '../../src/adapters/native-host-client';
import { NATIVE_PROOF_LIMITS, NativeProofCodec } from '../../src/adapters/native-host-codec';
import { createWKHostTransport } from '../../src/adapters/wk-host-transport';
import { applyCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import type { DomainOptions } from '../../src/domain/types';

const bootstrap = { v: 1, connectionId: '51000000-0000-4000-8000-000000000001', generation: 2 };
const workspaceHandle = 'invented-workspace-handle';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idMaker = (prefix: string) => {
  let index = 0;
  return () => `${prefix}-0000-4000-8000-${String(++index).padStart(12, '0')}`;
};

/**
 * Behaves like the Mac side: bind replies arrive after a delay, and
 * beginRecording() synchronously reads only the binding that already exists.
 */
class StandInHost {
  readonly events = new EventTarget();
  readonly operations: string[] = [];
  private readonly bindings = new Set<string>();
  private current: string | undefined;
  private readonly bindingId = idMaker('b7000000');
  private readonly deliveryId = idMaker('d7000000');
  constructor(private readonly delayMs = 20) {}

  readonly postMessage = async (envelope: Record<string, unknown>) => {
    this.operations.push(envelope.operation as string);
    await wait(this.delayMs);
    const reply = { v: 1, requestId: envelope.requestId, connectionId: envelope.connectionId,
      generation: envelope.generation, operation: envelope.operation };
    const payload = envelope.payload as Record<string, unknown>;
    if (envelope.operation === 'dictation.bindDraft') {
      const id = this.bindingId();
      this.bindings.add(id);
      this.current = id;
      return { ...reply, outcome: 'ok', revision: payload.expectedRevision, bindingId: id };
    }
    const id = payload.bindingId as string;
    if (!this.bindings.delete(id)) return { ...reply, outcome: 'refused', reason: 'unknown-binding' };
    if (this.current === id) this.current = undefined;
    return { ...reply, outcome: 'ok' };
  };

  beginRecording(): string | undefined { return this.current; }

  deliverFinal(token: string | undefined, text: string): string | 'held' {
    if (!token || !this.bindings.has(token)) return 'held';
    this.bindings.delete(token);
    if (this.current === token) this.current = undefined;
    const deliveryId = this.deliveryId();
    this.push({ type: 'dictation.final', bindingId: token, deliveryId, text });
    return deliveryId;
  }

  push(detail: Record<string, unknown>) {
    this.events.dispatchEvent(Object.assign(new Event('trueconvo-host'), {
      detail: { connectionId: bootstrap.connectionId, generation: bootstrap.generation, ...detail },
    }));
  }
}

function setup(delayMs = 20) {
  const host = new StandInHost(delayMs);
  const transport = createWKHostTransport(bootstrap, host.postMessage, host.events);
  const codec = new NativeProofCodec(transport.context, 32);
  const client = new NativeHostClient(transport, codec, { ...transport.context, maxRetainedRequests: 32,
    timeoutMs: 2_000, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes });
  const lane = new NativeDictationLane({ client, context: transport.context, workspaceHandle,
    events: host.events, requestId: idMaker('a1000000'), settleMs: 0 });
  const finals: DictationFinal[] = [];
  lane.onFinal((final) => finals.push(final));
  const options: DomainOptions = { id: idMaker('c3000000'), now: () => '2026-10-12T12:00:00.000Z' };
  const base = createDemoState(options);
  const sessionId = base.selection.sessionId ?? base.sessions[0]!.id;
  const selected = base.selection.sessionId === sessionId ? base
    : applyCommand(base, { type: 'select-session', sessionId }, options);
  const state = applyCommand(selected, { type: 'set-draft', sessionId, text: 'Before after' }, options);
  return { host, lane, finals, options, state, sessionId };
}

const until = async (check: () => boolean, label: string) => {
  for (let tries = 0; tries < 200; tries++) { if (check()) return; await wait(5); }
  assert.fail(`Timed out waiting for ${label}.`);
};

test('a recording that starts before the bind reply captures nothing; the lane reports ready only once bound', async () => {
  const { host, lane, state, sessionId } = setup(30);
  lane.setTarget({ state, sessionId, selection: { start: 7, end: 7 } });
  assert.equal(lane.status, 'binding');
  assert.equal(host.beginRecording(), undefined, 'The Mac sees no binding before the reply.');
  await until(() => lane.status === 'ready', 'the bind reply');
  assert.ok(host.beginRecording(), 'After the confirmed bind, a recording captures this draft.');
  lane.revoke();
});

test('a final for the bound draft is placed at the captured caret as unsent text', async () => {
  const { host, lane, finals, options, state, sessionId } = setup();
  const selection = { start: 7, end: 7 };
  lane.setTarget({ state, sessionId, selection });
  await until(() => lane.status === 'ready', 'binding');
  assert.notEqual(host.deliverFinal(host.beginRecording(), 'invented words '), 'held');
  assert.equal(finals.length, 1);
  const final = finals[0]!;
  assert.ok(final.capture && final.target);
  const result = final.capture.deliver(state, final.target, selection, final.deliveryId, final.text, options);
  assert.equal(result.kind, 'applied-in-memory');
  if (result.kind === 'applied-in-memory') assert.equal(result.state.drafts[sessionId], 'Before invented words after');
  assert.equal(lane.status, 'off', 'A used binding is not reused; the next target rebinds.');
  lane.revoke();
});

test('every new revision rebinds, so an unrelated save never leaves a stale binding', async () => {
  const { host, lane, options, state, sessionId } = setup();
  lane.setTarget({ state, sessionId, selection: { start: 0, end: 0 } });
  await until(() => lane.status === 'ready', 'first binding');
  const first = host.beginRecording();
  const next = applyCommand(state, { type: 'rename-session', sessionId, title: 'Invented renamed session' }, options);
  assert.ok(next.revision > state.revision);
  lane.setTarget({ state: next, sessionId, selection: { start: 0, end: 0 } });
  await until(() => lane.status === 'ready' && host.beginRecording() !== first, 'rebinding');
  assert.deepEqual(host.operations, ['dictation.bindDraft', 'dictation.unbindDraft', 'dictation.bindDraft']);
  lane.revoke();
});

test('leaving the draft unbinds, so a later recording cannot land in it', async () => {
  const { host, lane, state, sessionId } = setup();
  lane.setTarget({ state, sessionId, selection: { start: 0, end: 0 } });
  await until(() => lane.status === 'ready', 'binding');
  lane.setTarget(null);
  assert.equal(lane.status, 'off');
  await until(() => host.beginRecording() === undefined, 'unbinding');
  assert.equal(host.deliverFinal(host.beginRecording(), 'stray words'), 'held');
  lane.revoke();
});

test('a late final for a replaced binding still reaches the App with its own capture, which refuses a changed workspace', async () => {
  const { host, lane, finals, options, state, sessionId } = setup();
  const selection = { start: 0, end: 0 };
  lane.setTarget({ state, sessionId, selection });
  await until(() => lane.status === 'ready', 'binding');
  const token = host.beginRecording();
  const next = applyCommand(state, { type: 'rename-session', sessionId, title: 'Invented renamed session' }, options);
  // The Mac delivers to the token it captured, before the lane's unbind lands.
  host.deliverFinal(token, 'kept words');
  lane.setTarget({ state: next, sessionId, selection });
  const final = finals[0]!;
  assert.ok(final.capture && final.target, 'The final is matched to its binding, never dropped.');
  const result = final.capture.deliver(next, final.target, selection, final.deliveryId, final.text, options);
  assert.equal(result.kind, 'conflict', 'The App keeps this text for the owner instead of placing it.');
  lane.revoke();
});

test('a final for an unknown binding arrives without a capture, so the App keeps it unplaced', async () => {
  const { host, lane, finals } = setup();
  host.push({ type: 'dictation.final', bindingId: 'b9000000-0000-4000-8000-000000000001',
    deliveryId: 'd9000000-0000-4000-8000-000000000001', text: 'orphan words' });
  assert.equal(finals.length, 1);
  assert.equal(finals[0]!.capture, undefined);
  assert.equal(finals[0]!.text, 'orphan words');
  lane.revoke();
});

test('receipts are forwarded; malformed or foreign events are ignored', async () => {
  const { host, lane, finals } = setup();
  const receipts: string[] = [];
  lane.onReceipt((id) => receipts.push(id));
  host.push({ type: 'dictation.receipt', deliveryId: 'd9000000-0000-4000-8000-000000000002',
    commitRequestId: 'e9000000-0000-4000-8000-000000000001', revision: 4 });
  host.push({ type: 'dictation.final', bindingId: 'not-a-uuid', deliveryId: 'd9000000-0000-4000-8000-000000000003', text: 'x' });
  host.events.dispatchEvent(Object.assign(new Event('trueconvo-host'), { detail: { type: 'dictation.final',
    connectionId: 'another-connection', generation: 2, bindingId: 'b9000000-0000-4000-8000-000000000002',
    deliveryId: 'd9000000-0000-4000-8000-000000000004', text: 'foreign' } }));
  assert.deepEqual(receipts, ['d9000000-0000-4000-8000-000000000002']);
  assert.equal(finals.length, 0);
  lane.revoke();
});

test('a lock revokes the lane and forgets every capture', async () => {
  const { host, lane, finals, state, sessionId } = setup();
  lane.setTarget({ state, sessionId, selection: { start: 0, end: 0 } });
  await until(() => lane.status === 'ready', 'binding');
  host.push({ type: 'host.connection', state: 'locked', reason: 'lock' });
  assert.equal(lane.status, 'unavailable');
  host.push({ type: 'dictation.final', bindingId: 'b7000000-0000-4000-8000-000000000001',
    deliveryId: 'd9000000-0000-4000-8000-000000000005', text: 'after lock' });
  assert.equal(finals.length, 0);
});
