import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initializeNativeProof } from '../../src/app/native-bootstrap';
import type { DeskState } from '../../src/domain/types';
import type { NativeParticipantAvailability } from '../../src/adapters/native-participant-codec';

type Wire = Record<string, any>;
const vectors = JSON.parse(readFileSync(new URL('../fixtures/native-participant-v1.json', import.meta.url), 'utf8')) as {
  context: { connectionId: string; documentGeneration: number };
  cases: { name: string; request: Wire; reply: Wire }[];
};
const legacy = JSON.parse(readFileSync(new URL('../fixtures/native-host-v1.json', import.meta.url), 'utf8')) as typeof vectors;
const sample = (name: string) => structuredClone(vectors.cases.find(entry => entry.name === name)!);
const bootstrap = { v: 1, connectionId: vectors.context.connectionId, generation: vectors.context.documentGeneration };
const nextIds = () => {
  let index = 0;
  return () => `a0000000-0000-4000-8000-${String(++index).padStart(12, '0')}`;
};
const fullOperations = sample('host.capabilities on a participant host').reply.capabilities.operations as string[];
const active = () => sample('participant.availability confirmation: active, confirmed this launch (test fake)').reply.participants[0] as NativeParticipantAvailability;
const unconfirmed = () => sample('participant.availability confirmation: not yet confirmed this launch').reply.participants[0] as NativeParticipantAvailability;

class TrackedEvents extends EventTarget {
  readonly listeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === 'trueconvo-host' && callback) this.listeners.add(callback);
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (type === 'trueconvo-host' && callback) this.listeners.delete(callback);
    super.removeEventListener(type, callback, options);
  }
}
function host(operations = fullOperations) {
  const events = new TrackedEvents();
  const sent: Wire[] = [];
  let record = structuredClone(legacy.cases.find(entry => entry.name === 'workspace.read')!.reply.record) as DeskState;
  let entry = active();
  let availability: ((request: Wire) => Promise<unknown>) | undefined;
  const base = (request: Wire) => ({ v: 1, connectionId: request.connectionId, generation: request.generation,
    operation: request.operation, requestId: request.requestId });
  const response = (request: Wire): Wire => {
    if (request.operation === 'host.capabilities') {
      const capabilities = sample('host.capabilities on a participant host').reply.capabilities;
      capabilities.operations = [...operations];
      return { ...base(request), outcome: 'ok', capabilities };
    }
    if (request.operation === 'participant.availability') return { ...base(request), outcome: 'ok', participants: [structuredClone(entry)] };
    if (request.operation === 'workspace.read') return { ...base(request), outcome: 'ok', revision: record.revision, record: structuredClone(record) };
    if (request.operation === 'workspace.commitProof') {
      assert.equal(request.payload.expectedRevision, record.revision);
      record = structuredClone(request.payload.record);
      return { ...base(request), outcome: 'ok', revision: record.revision };
    }
    throw new Error(`Unexpected operation ${request.operation}`);
  };
  return {
    events, sent, response,
    setEntry(next: NativeParticipantAvailability) { entry = next; },
    setAvailability(next?: (request: Wire) => Promise<unknown>) { availability = next; },
    environment: { bootstrap, events, postMessage: async (request: Wire) => {
      sent.push(structuredClone(request));
      return request.operation === 'participant.availability' && availability ? availability(request) : response(request);
    } },
  };
}
function revoke(events: EventTarget, state: 'locked' | 'revoked') {
  events.dispatchEvent(Object.assign(new Event('trueconvo-host'), {
    detail: { type: 'host.connection', connectionId: bootstrap.connectionId, generation: bootstrap.generation, state, reason: state },
  }));
}

for (const count of [5, 7, 8, 9, 10, 11]) {
  test(`${count} advertised operations do not query or expose a partial participant connection`, async () => {
    const h = host(fullOperations.slice(0, count));
    const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 50 });
    assert.equal(initialized.kind, 'ready');
    if (initialized.kind !== 'ready') return;
    try {
      const runtime = initialized.runtime;
      assert.equal(runtime.participant, undefined);
      assert.equal(runtime.participantChoices, undefined);
      assert.equal(runtime.participantConfirmation, undefined);
      assert.equal(runtime.participantForRun, undefined);
      assert.equal(runtime.refreshParticipants, undefined);
      assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities']);
      assert.equal((await runtime.workspace.loadLatest()).kind, 'ready');
      assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities', 'workspace.read']);
    } finally { initialized.runtime.revoke(); }
    assert.equal(h.events.listeners.size, 0);
  });
}

for (const [name, operations] of [
  ['reordered participant operations', [...fullOperations.slice(0, 7), ...fullOperations.slice(7).reverse()]],
  ['reordered legacy operations in a participant host', [fullOperations[1]!, fullOperations[0]!, ...fullOperations.slice(2)]],
  ['all participant names without reconciliation', fullOperations.filter(operation => operation !== 'workspace.reconcile')],
  ['all participant names without dictation receipts', fullOperations.filter(operation => operation !== 'dictation.receipt')],
] as const) {
  test(`${name} refuses the participant host without sending availability`, async () => {
    const h = host([...operations]);
    const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 50 });
    assert.equal(initialized.kind, 'unavailable');
    assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities']);
    assert.equal(h.events.listeners.size, 0);
  });
}

test('legacy capability ordering remains accepted without participant authority', async () => {
  const h = host(fullOperations.slice(0, 7).reverse());
  const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 50 });
  assert.equal(initialized.kind, 'ready');
  if (initialized.kind !== 'ready') return;
  try {
    assert.equal(initialized.runtime.participant, undefined);
    assert.equal((await initialized.runtime.workspace.loadLatest()).kind, 'ready');
    assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities', 'workspace.read']);
  } finally { initialized.runtime.revoke(); }
});

test('full capabilities connect the exact four-field pin, dynamic catalog and separate display confirmation', async () => {
  const h = host();
  const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 50 });
  assert.equal(initialized.kind, 'ready');
  if (initialized.kind !== 'ready') return;
  const runtime = initialized.runtime;
  try {
    await runtime.refreshParticipants!();
    const pin = { id: 'claude-code', label: 'Claude Code', model: 'invented-pinned-model', executionHost: 'this-mac' };
    const port = runtime.participant!;
    assert.deepEqual(port.identity, pin);
    assert.equal(port.canStart?.(), true);
    assert.deepEqual(Object.keys(port.identity).sort(), ['executionHost', 'id', 'label', 'model']);
    assert.deepEqual(runtime.participantChoices, [{ identity: pin, provider: 'Claude subscription', destination: 'Anthropic cloud',
      approved: true, available: true, unavailableReason: null }]);
    assert.deepEqual(runtime.participantConfirmation, { state: 'active', confirmedAt: '2026-10-09T00:00:30.000Z', runsLeft: 5 });
    assert.equal(runtime.participantInputLimit, 4096);
    assert.ok(Object.isFrozen(runtime.participantChoices));
    assert.ok(Object.isFrozen(runtime.participantChoices![0].identity));
    const changes: { checking: boolean | undefined; available: boolean; confirmation: unknown }[] = [];
    const unsubscribe = runtime.subscribeParticipants!(() => {
      changes.push({ checking: runtime.participantAvailabilityChecking, available: runtime.participantChoices![0].available,
        confirmation: runtime.participantConfirmation });
    });
    h.setEntry(unconfirmed());
    await runtime.refreshParticipants!();
    assert.deepEqual(changes, [
      { checking: true, available: false, confirmation: undefined },
      { checking: false, available: false, confirmation: { state: 'unconfirmed' } },
    ]);
    assert.equal(runtime.participantChoices![0].available, false);
    assert.match(runtime.participantChoices![0].unavailableReason!, /confirm|overflow/i);
    assert.deepEqual(runtime.participantChoices![0].identity, pin);
    assert.deepEqual(runtime.participantConfirmation, { state: 'unconfirmed' });
    assert.equal(port.canStart?.(), false);
    // An update can change the live pin, but recovery of an old run retains its recorded identity.
    const changedPin = { ...active(), model: 'invented-newer-pinned-model' };
    h.setEntry(changedPin);
    await runtime.refreshParticipants!();
    assert.deepEqual(changes.slice(2), [
      { checking: true, available: false, confirmation: undefined },
      { checking: false, available: true, confirmation: changedPin.confirmation },
    ]);
    assert.equal(runtime.participant!.identity.model, changedPin.model);
    assert.equal(runtime.participantChoices![0].identity.model, changedPin.model);
    const recovery = runtime.participantForRun!(pin);
    assert.deepEqual(recovery.identity, pin);
    assert.equal(recovery.canStart?.(), false);
    assert.equal(port.canStart?.(), false);
    unsubscribe();
    assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities', 'participant.availability', 'participant.availability',
      'participant.availability', 'participant.availability']);
    assert.ok(!h.sent.some(request => request.operation === 'participant.start'));
  } finally { runtime.revoke(); }
  assert.equal(h.events.listeners.size, 0);
  assert.equal(runtime.participant, undefined);
  assert.deepEqual(runtime.participantChoices, []);
  assert.equal(runtime.participantConfirmation, undefined);
});

for (const failure of ['transport', 'refused', 'malformed', 'timeout'] as const) {
  test(`initial ${failure} availability leaves the workspace readable and writable without participant authority`, async () => {
    const h = host();
    h.setAvailability(async request => {
      if (failure === 'transport') throw new Error('invented diagnostic');
      if (failure === 'timeout') return new Promise(() => {});
      const reply = h.response(request);
      if (failure === 'refused') return { v: reply.v, connectionId: reply.connectionId, generation: reply.generation,
        operation: reply.operation, requestId: reply.requestId, outcome: 'refused', reason: 'unknown-operation' };
      return { ...reply, extra: 'invalid field' };
    });
    const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 5 });
    assert.equal(initialized.kind, 'ready');
    if (initialized.kind !== 'ready') return;
    try {
      const runtime = initialized.runtime;
      await runtime.refreshParticipants!();
      assert.equal(runtime.isActive(), true);
      assert.equal(runtime.participant, undefined);
      assert.deepEqual(runtime.participantChoices, []);
      assert.equal(runtime.participantConfirmation, undefined);
      const loaded = await runtime.workspace.loadLatest();
      assert.equal(loaded.kind, 'ready');
      if (loaded.kind !== 'ready') return;
      const changed = structuredClone(loaded.state); changed.revision++;
      assert.equal((await runtime.workspace.save(changed, loaded.state.revision)).kind, 'saved');
      const reread = await runtime.workspace.loadLatest();
      assert.equal(reread.kind, 'ready');
      if (reread.kind === 'ready') assert.deepEqual(reread.state, changed);
      assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities', 'participant.availability', 'participant.availability',
        'workspace.read', 'workspace.commitProof', 'workspace.read']);
    } finally { initialized.runtime.revoke(); }
    assert.equal(h.events.listeners.size, 0);
  });
}

test('a stalled initial availability check does not delay workspace opening, reading or saving', async () => {
  const h = host();
  let release!: (reply: unknown) => void;
  let availabilityRequest!: Wire;
  h.setAvailability(request => { availabilityRequest = request; return new Promise(resolve => { release = resolve; }); });
  const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 100, maxRetainedRequests: 1 });
  assert.equal(initialized.kind, 'ready');
  if (initialized.kind !== 'ready') return;
  try {
    const runtime = initialized.runtime;
    assert.ok(availabilityRequest);
    assert.equal(runtime.participant, undefined);
    assert.deepEqual(runtime.participantChoices, []);
    const loaded = await runtime.workspace.loadLatest();
    assert.equal(loaded.kind, 'ready');
    if (loaded.kind !== 'ready') return;
    const changed = structuredClone(loaded.state); changed.revision++;
    assert.equal((await runtime.workspace.save(changed, loaded.state.revision)).kind, 'saved');
    const available = new Promise<void>(resolve => {
      const unsubscribe = runtime.subscribeParticipants!(() => { unsubscribe(); resolve(); });
    });
    release(h.response(availabilityRequest));
    await available;
    assert.equal(runtime.participant!.canStart?.(), true);
    assert.equal(h.sent.filter(request => request.operation === 'participant.start').length, 0);
  } finally { initialized.runtime.revoke(); }
});

test('an idle open workspace never polls availability in the background', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = host();
  const initialized = await initializeNativeProof(h.environment, { requestId: nextIds() });
  assert.equal(initialized.kind, 'ready');
  if (initialized.kind !== 'ready') return;
  try {
    await initialized.runtime.refreshParticipants!();
    const checks = h.sent.filter(request => request.operation === 'participant.availability').length;
    for (let step = 0; step < 4; step++) {
      t.mock.timers.tick(15_000);
      await Promise.resolve(); await Promise.resolve();
      assert.equal(h.sent.filter(request => request.operation === 'participant.availability').length, checks);
    }
    assert.equal(initialized.runtime.isActive(), true);
  } finally { initialized.runtime.revoke(); }
});

for (const state of ['locked', 'revoked'] as const) {
  test(`${state} during initial availability clears the ready runtime and ignores a late successful reply`, async () => {
    const h = host();
    let release!: (reply: unknown) => void;
    let availabilityRequest!: Wire;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    h.setAvailability(request => {
      availabilityRequest = request;
      return new Promise(resolve => { release = resolve; reached(); });
    });
    const initialized = await initializeNativeProof(h.environment, { requestId: nextIds(), timeoutMs: 100 });
    assert.equal(initialized.kind, 'ready');
    if (initialized.kind !== 'ready') return;
    const runtime = initialized.runtime;
    await waiting;
    // Workspace transport, participant transport and port, dictation transport and lane.
    assert.equal(h.events.listeners.size, 5);
    let invalidations = 0;
    runtime.subscribeInvalidation(() => { invalidations++; });
    revoke(h.events, state);
    assert.equal(runtime.isActive(), false);
    assert.equal(invalidations, 1);
    assert.equal(h.events.listeners.size, 0);
    release(h.response(availabilityRequest));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(runtime.isActive(), false);
    assert.equal(runtime.participant, undefined);
    assert.deepEqual(runtime.participantChoices, []);
    assert.equal(runtime.participantConfirmation, undefined);
    assert.deepEqual(h.sent.map(request => request.operation), ['host.capabilities', 'participant.availability']);
  });
}
