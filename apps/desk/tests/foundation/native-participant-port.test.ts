import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NativeProofCodec, NATIVE_PROOF_LIMITS, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';
import { NativeParticipantConnection, nativeParticipantInputWithinLimit } from '../../src/adapters/native-participant-port';
import type { ParticipantStartInput } from '../../src/adapters/participant-runtime';

const context = { connectionId: 'invented-participant-connection', documentGeneration: 2 };
const identity = { id: 'claude-code', label: 'Invented Claude participant', model: 'invented-model', executionHost: 'this-mac' };
const target = { runId: '12000000-0000-4000-8000-000000000001', sessionId: '12000000-0000-4000-8000-000000000002' };
const input: ParticipantStartInput = { ...target, userMessageId: '12000000-0000-4000-8000-000000000003',
  assistantMessageId: '12000000-0000-4000-8000-000000000004', participant: identity, inputChunks: ['Invented question.'] };
const at = '2026-10-10T12:00:00.000Z';
const started = { ...target, sequence: 1, at, type: 'started' };
const terminal = { ...target, sequence: 4, at, type: 'stopped', reason: 'local-stop' };
const requestId = (n: number) => `13000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type WireRequest = { v: number; requestId: string; connectionId: string; generation: number; operation: string; payload: Record<string, unknown> };
type Reply = Record<string, unknown>;

function setup(handler?: (request: WireRequest) => Reply | Promise<Reply>) {
  const requests: WireRequest[] = [];
  const events = new EventTarget();
  let deliver = (_wire: string) => {};
  let seq = 0;
  let revoked = 0;
  const defaultReply = (request: WireRequest): Reply => {
    switch (request.operation) {
      case 'participant.availability': return { outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] };
      case 'participant.start': return { outcome: 'ok', runId: target.runId };
      case 'participant.stop': return { outcome: 'ok', runId: target.runId, state: 'exited', terminal, groupCleared: true, providerCancelConfirmed: false };
      case 'participant.status': return { outcome: 'ok', runId: target.runId, state: 'running', terminal: null, lastSequence: 1, groupCleared: null, unknownReason: null };
      default: throw new Error('No invented response assigned.');
    }
  };
  const transport: NativeHostTransport = {
    listen(reply) { deliver = reply; return () => {}; },
    async send(wire) {
      const request = JSON.parse(wire) as WireRequest;
      requests.push(request);
      const response = await (handler?.(request) ?? defaultReply(request));
      const { payload: _payload, ...base } = request;
      deliver(JSON.stringify({ ...base, ...response }));
    },
  };
  const codec = new NativeProofCodec(context, 128);
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec,
    { ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 128, timeoutMs: 1000,
      operationTimeoutMs: { 'participant.availability': 30, 'participant.start': 30, 'participant.events': 30, 'participant.stop': 30, 'participant.status': 30 } });
  const connection = new NativeParticipantConnection({ client, context, workspaceHandle: 'invented-workspace', events,
    requestId: () => requestId(++seq), onRevoked: () => { revoked++; } });
  return { connection, port: connection.portFor(identity), client, events, requests, revoked: () => revoked,
    push: (detail: unknown) => events.dispatchEvent(new CustomEvent('trueconvo-host', { detail })), defaultReply };
}

test('native port is inert, requires a fresh exact native pin, and never retries or falls back', async t => {
  const h = setup();
  t.after(() => h.connection.dispose());
  assert.equal(h.requests.length, 0);
  assert.equal(h.port.canStart?.(), false);
  assert.deepEqual(await h.port.start(input), { kind: 'accepted' });
  assert.deepEqual(h.requests.map(r => r.operation), ['participant.availability', 'participant.start']);
  assert.equal(h.port.canStart?.(), true);
  assert.deepEqual(h.requests[1].payload, { workspaceHandle: 'invented-workspace', ...input });
  assert.notEqual(h.requests[0].requestId, h.requests[1].requestId);
  const old = h.connection.portFor({ ...identity, model: 'invented-previous-pin' });
  assert.equal(old.identity.model, 'invented-previous-pin');
  assert.equal(old.canStart?.(), false);
  assert.deepEqual(await old.start({ ...input, participant: old.identity }), { kind: 'not-started', reason: 'participant-changed', retryable: false });
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 1);
  assert.equal((await old.status!(target)).kind, 'status');
  assert.equal((await old.stop(target)).kind, 'confirmed');
});

test('input ceiling counts UTF-8 across chunks, keeps the entire input and dispatches nothing above it', async t => {
  const h = setup();
  t.after(() => h.connection.dispose());
  assert.equal(nativeParticipantInputWithinLimit(['é'.repeat(2048)]), true);
  assert.equal(nativeParticipantInputWithinLimit(['é'.repeat(2048), 'a']), false);
  assert.equal(nativeParticipantInputWithinLimit(['\ud800']), false);
  const chunks = ['é'.repeat(2048), 'a'];
  assert.deepEqual(await h.port.start({ ...input, inputChunks: chunks }), { kind: 'not-started', reason: 'text-too-large', retryable: false });
  assert.deepEqual(chunks, ['é'.repeat(2048), 'a']);
  assert.equal(h.requests.length, 0);
});

test('availability loss revokes stale Start permission but retains recovery for unavailable pins', async t => {
  let checks = 0;
  const h = setup(request => request.operation === 'participant.availability'
    ? ++checks === 1 ? { outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] }
      : { outcome: 'ok', participants: [{ ...identity, available: false, reason: 'overflow-unverified', confirmation: { state: 'unconfirmed' } }] }
    : h.defaultReply(request));
  t.after(() => h.connection.dispose());
  await h.connection.refreshAvailability();
  assert.equal(h.port.canStart?.(), true);
  assert.deepEqual(await h.port.start(input), { kind: 'not-started', reason: 'participant-unavailable', retryable: true });
  assert.equal(h.port.canStart?.(), false);
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 0);
  assert.equal((await h.port.stop(target)).kind, 'confirmed');
});

test('Start uses its own fresh check when a newer picker refresh overtakes it', async () => {
  for (const refresh of ['available', 'unavailable', 'refused', 'different-pin'] as const) {
    let held!: (reply: Reply) => void;
    let checks = 0;
    const h = setup(request => {
      if (request.operation !== 'participant.availability') return h.defaultReply(request);
      if (++checks === 2) return new Promise(resolve => { held = resolve; });
      if (checks === 1) return h.defaultReply(request);
      if (refresh === 'refused') return { outcome: 'refused', reason: 'unknown-connection' };
      return { outcome: 'ok', participants: [{ ...identity,
        model: refresh === 'different-pin' ? 'invented-other-pin' : identity.model,
        available: refresh !== 'unavailable', reason: refresh === 'unavailable' ? 'check-failed' : null }] };
    });
    try {
      await h.connection.refreshAvailability();
      const starting = h.port.start(input);
      await h.connection.refreshAvailability();
      const newestDisplay = h.connection.snapshot;
      held({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
      assert.deepEqual(await starting, { kind: 'accepted' }, refresh);
      assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 1, refresh);
      assert.deepEqual(h.connection.snapshot, newestDisplay, 'The older Start reply must not overwrite the newer display.');
      assert.equal(h.port.canStart?.(), refresh === 'available', 'The picker retains only its newest permission.');
    } finally { h.connection.dispose(); }
  }
});

test('overlapping Starts each use their own availability evidence without borrowing the newer display', async t => {
  const held: ((reply: Reply) => void)[] = [];
  const h = setup(request => request.operation === 'participant.availability'
    ? new Promise(resolve => { held.push(resolve); }) : h.defaultReply(request));
  t.after(() => h.connection.dispose());
  const first = h.port.start(input);
  const second = h.port.start(input);
  held[1]({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
  assert.deepEqual(await second, { kind: 'accepted' });
  held[0]({ outcome: 'ok', participants: [{ ...identity, available: false, reason: 'check-failed' }] });
  assert.deepEqual(await first, { kind: 'not-started', reason: 'participant-unavailable', retryable: true });
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 1);
  assert.equal(h.connection.snapshot.available, true);
  assert.equal(h.connection.snapshot.error, null);
});

test('failed availability checks preserve known identity, revoke permission and report honest errors', async () => {
  for (const mode of ['timeout', 'transport', 'refused', 'malformed'] as const) {
    for (const known of [false, true]) {
      let failing = !known;
      const h = setup(request => {
        if (request.operation !== 'participant.availability' || !failing) return h.defaultReply(request);
        if (mode === 'timeout') return new Promise<Reply>(() => {});
        if (mode === 'transport') throw new Error('Invented unavailable transport.');
        if (mode === 'refused') return { outcome: 'refused', reason: 'unknown-connection' };
        return { outcome: 'ok', participants: [{ ...identity, available: 'not-a-boolean', reason: null }] };
      });
      try {
        if (known) await h.connection.refreshAvailability();
        const previousEntry = h.connection.snapshot.entry;
        failing = true;
        await h.connection.refreshAvailability();
        const snapshot = h.connection.snapshot;
        assert.deepEqual(snapshot.entry, previousEntry, `${mode}: a failed check must not remove a known identity`);
        assert.equal(snapshot.available, false, mode);
        assert.equal(h.port.canStart?.(), false, mode);
        // A malformed reply cannot become authority: the strict client ignores
        // it and the request eventually times out without exposing its content.
        assert.equal(snapshot.error, mode === 'refused' ? 'unknown-connection' : mode === 'malformed' ? 'timeout' : mode);
        failing = false;
        await h.connection.refreshAvailability();
        assert.equal(h.connection.snapshot.available, true);
        assert.equal(h.connection.snapshot.error, null);
      } finally { h.connection.dispose(); }
    }
  }
});

test('late availability successes and failures cannot overwrite the newest display result', async () => {
  for (const olderFails of [false, true]) {
    let held!: (reply: Reply) => void;
    let checks = 0;
    const h = setup(request => {
      if (request.operation !== 'participant.availability') return h.defaultReply(request);
      if (++checks === 2) return new Promise(resolve => { held = resolve; });
      if (checks === 3 && !olderFails) return { outcome: 'refused', reason: 'unknown-connection' };
      return h.defaultReply(request);
    });
    try {
      await h.connection.refreshAvailability();
      const older = h.connection.refreshAvailability();
      await h.connection.refreshAvailability();
      const newest = h.connection.snapshot;
      held(olderFails ? { outcome: 'refused', reason: 'unknown-connection' }
        : { outcome: 'ok', participants: [{ ...identity, model: 'invented-late-pin', available: true, reason: null }] });
      await older;
      assert.deepEqual(h.connection.snapshot, newest);
      assert.equal(h.connection.snapshot.available, olderFails);
    } finally { h.connection.dispose(); }
  }
});

test('availability checking follows only the newest read and never presents stale permission while pending', async t => {
  const held: ((reply: Reply) => void)[] = [];
  let initial = true;
  const h = setup(request => request.operation === 'participant.availability' && !initial
    ? new Promise(resolve => { held.push(resolve); }) : h.defaultReply(request));
  t.after(() => h.connection.dispose());
  const seen: { checking: boolean; available: boolean }[] = [];
  h.connection.subscribeChanges(() => { seen.push(h.connection.snapshot); });
  assert.equal(h.connection.snapshot.checking, false);
  await h.connection.refreshAvailability();
  assert.equal(h.connection.snapshot.available, true);
  initial = false;
  const older = h.connection.refreshAvailability();
  const newest = h.connection.refreshAvailability();
  assert.equal(h.connection.snapshot.checking, true);
  assert.equal(h.connection.snapshot.available, false);
  assert.deepEqual(h.connection.snapshot.entry, { ...identity, available: true, reason: null }, 'Identity remains available for recovery.');
  held[0]({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
  await older;
  assert.equal(h.connection.snapshot.checking, true, 'An older reply cannot finish the current check.');
  assert.equal(h.connection.snapshot.available, false);
  held[1]({ outcome: 'refused', reason: 'unknown-connection' });
  await newest;
  assert.equal(h.connection.snapshot.checking, false);
  assert.equal(h.connection.snapshot.available, false);
  assert.equal(h.connection.snapshot.error, 'unknown-connection');
  assert.deepEqual(seen.map(snapshot => [snapshot.checking, snapshot.available]),
    [[true, false], [false, true], [true, false], [true, false], [false, false]]);
});

test('a fresh Start may finish while a newer display read is still checking, without borrowing its authority', async t => {
  const held: ((reply: Reply) => void)[] = [];
  const h = setup(request => request.operation === 'participant.availability'
    ? new Promise(resolve => { held.push(resolve); }) : h.defaultReply(request));
  t.after(() => h.connection.dispose());
  const starting = h.port.start(input);
  const newest = h.connection.refreshAvailability();
  held[0]({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
  assert.deepEqual(await starting, { kind: 'accepted' });
  assert.equal(h.connection.snapshot.checking, true);
  assert.equal(h.connection.snapshot.available, false);
  assert.equal(h.requests.filter(request => request.operation === 'participant.start').length, 1);
  h.connection.dispose();
  assert.equal(h.connection.snapshot.checking, false);
  held[1]({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
  await newest;
  assert.equal(h.connection.snapshot.checking, false);
  assert.equal(h.connection.snapshot.available, false);
  assert.equal(h.connection.snapshot.entry, null);
});

test('an unsaved tail acquired during the held availability check prevents dispatch until an explicit later Start', async t => {
  let held: ((reply: Reply) => void) | undefined;
  let allow = true;
  let checks = 0;
  const h = setup(request => {
    if (request.operation === 'participant.availability' && ++checks === 1) return new Promise(resolve => { held = resolve; });
    return h.defaultReply(request);
  });
  t.after(() => h.connection.dispose());
  const starting = h.port.start(input, () => allow);
  allow = false;
  held!({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
  assert.deepEqual(await starting, { kind: 'not-started', reason: 'workspace-not-ready', retryable: true });
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 0);
  allow = true;
  await Promise.resolve();
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 0, 'Settling a save never retries a Start.');
  assert.deepEqual(await h.port.start(input, () => allow), { kind: 'accepted' });
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 1);
  assert.deepEqual(await h.port.start(input, () => { throw new Error('Invented latch failure'); }),
    { kind: 'not-started', reason: 'workspace-not-ready', retryable: true });
  assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 1);
});

test('all native start refusals preserve exact reason, ambiguity and explicit retry meaning', async () => {
  const unknown = new Set(['duplicate-run', 'payload-mismatch', 'store-corrupt', 'store-missing']);
  const retryable = new Set(['participant-busy', 'participant-unavailable', 'store-locked', 'unknown-connection', 'stale-generation']);
  const reasons = [...unknown, ...retryable, 'unknown-run', 'run-not-prepared', 'run-mismatch', 'participant-changed', 'text-too-large', 'invalid-identity'];
  for (const reason of reasons) {
    const h = setup(request => request.operation === 'participant.start' ? { outcome: 'refused', reason } : h.defaultReply(request));
    try {
      assert.deepEqual(await h.port.start(input), unknown.has(reason) ? { kind: 'unknown' }
        : { kind: 'not-started', reason, retryable: retryable.has(reason) }, reason);
      assert.equal(h.requests.filter(r => r.operation === 'participant.start').length, 1);
      if (reason === 'store-locked') assert.equal(h.revoked(), 1);
    } finally { h.connection.dispose(); }
  }
  for (const mode of ['unknown', 'transport'] as const) {
    const h = setup(request => {
      if (request.operation !== 'participant.start') return h.defaultReply(request);
      if (mode === 'transport') throw new Error('invented transport failure');
      return { outcome: 'unknown' };
    });
    try { assert.deepEqual(await h.port.start(input), { kind: 'unknown' }); assert.equal(h.requests.length, 2); }
    finally { h.connection.dispose(); }
  }
});

test('Stop maps local cleanup separately from transcript completion and never claims provider cancellation', async () => {
  const cases = [
    { reply: { state: 'exited', terminal, groupCleared: true }, kind: 'confirmed' },
    { reply: { state: 'exited', terminal: { ...terminal, sequence: 1 }, groupCleared: null }, kind: 'confirmed' },
    { reply: { state: 'exited', terminal: { ...terminal, reason: 'stop-incomplete' }, groupCleared: false }, kind: 'cleanup-uncertain', owned: false },
    { reply: { state: 'cleanup-pending', terminal: { ...terminal, reason: 'stop-incomplete' }, groupCleared: false }, kind: 'cleanup-uncertain', owned: true },
    { reply: { state: 'not-owned', terminal: null, groupCleared: null }, kind: 'unknown' },
  ];
  for (const item of cases) {
    const h = setup(() => ({ outcome: 'ok', runId: target.runId, providerCancelConfirmed: false, ...item.reply }));
    try {
      const result = await h.port.stop(target);
      assert.equal(result.kind, item.kind);
      if (result.kind === 'cleanup-uncertain') assert.equal(result.owned, item.owned);
    } finally { h.connection.dispose(); }
  }
  const h = setup(() => ({ outcome: 'refused', reason: 'unknown-run' }));
  try { assert.deepEqual(await h.port.stop(target), { kind: 'not-prepared' }); } finally { h.connection.dispose(); }
});

test('blocked workspace saving never blocks the participant Stop lane', async t => {
  const h = setup();
  t.after(() => h.connection.dispose());
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-host-v1.json', import.meta.url), 'utf8'));
  const saved = fixture.cases.find((entry: { name: string }) => entry.name === 'workspace.commitProof').request;
  const holdTransport: NativeHostTransport = { listen: () => () => {}, send: () => {} };
  const saveClient = new NativeHostClient<NativeProofRequest, NativeProofResult>(holdTransport, new NativeProofCodec(context, 4),
    { ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 4, timeoutMs: 60_000 });
  t.after(() => saveClient.revoke());
  const saving = saveClient.request({ requestId: requestId(99), operation: 'workspace.commitProof', payload: saved.payload });
  assert.equal((await h.port.stop(target)).kind, 'confirmed');
  saveClient.revoke();
  assert.equal((await saving).kind, 'unknown');
});

test('strict pushes reject stale documents and malformed terminal reasons; revoke clears listeners and ignores late replies', async t => {
  let resolve!: (reply: Reply) => void;
  const h = setup(() => new Promise(done => { resolve = done; }));
  t.after(() => h.connection.dispose());
  const received: unknown[] = [];
  h.port.subscribe(event => received.push(event));
  const push = { type: 'participant.event', connectionId: context.connectionId, generation: context.documentGeneration, event: started };
  h.push({ ...push, generation: 1 });
  h.push({ ...push, event: { ...terminal, reason: 'paid-overflow' } });
  assert.equal(received.length, 0);
  h.push(push);
  assert.deepEqual(received, [started]);
  const refreshing = h.connection.refreshAvailability();
  h.push({ type: 'host.connection', connectionId: context.connectionId, generation: 1, state: 'locked', reason: 'lock' });
  assert.equal(h.revoked(), 0);
  h.push({ type: 'host.connection', connectionId: context.connectionId, generation: context.documentGeneration, state: 'locked', reason: 'lock' });
  assert.equal(h.revoked(), 1);
  assert.equal(getEventListeners(h.events, 'trueconvo-host').length, 0);
  resolve({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null }] });
  await refreshing;
  h.push(push);
  assert.equal(received.length, 1);
  assert.deepEqual(h.connection.snapshot, { entry: null, local: [], route: null, available: false, checking: false, error: 'revoked' });
  assert.deepEqual(await h.port.stop(target), { kind: 'unknown' });
});

test('replay pages use fresh IDs and the last accepted sequence, then surface loss without discarding progress', async t => {
  const h = setup(request => request.payload.afterSequence === 0
    ? { outcome: 'ok', runId: target.runId, events: [started], more: true, lastSequence: 4, lost: null, terminal: null }
    : { outcome: 'ok', runId: target.runId, events: [], more: false, lastSequence: 4,
      lost: { fromSequence: 2, throughSequence: 3, reason: 'locked' }, terminal });
  t.after(() => h.connection.dispose());
  assert.deepEqual(await h.port.reconcile({ ...target, afterSequence: 0 }), { kind: 'events', events: [started], more: true });
  assert.deepEqual(h.requests.map(r => r.payload.afterSequence), [0, 1]);
  assert.notEqual(h.requests[0].requestId, h.requests[1].requestId);
  assert.deepEqual(await h.port.reconcile({ ...target, afterSequence: 1 }), { kind: 'lost', lost: { fromSequence: 2, throughSequence: 3, reason: 'locked' }, terminal });
});

test('unknown replay high-water cannot prove completion or discard accepted events; explicit restart loss remains loss', async t => {
  const unknownPage = { outcome: 'ok', runId: target.runId, events: [], more: false, lastSequence: null, lost: null, terminal: null };
  const unknown = setup(() => unknownPage);
  t.after(() => unknown.connection.dispose());
  assert.deepEqual(await unknown.port.reconcile({ ...target, afterSequence: 1 }), { kind: 'unknown' });

  const partial = setup(request => request.payload.afterSequence === 0
    ? { outcome: 'ok', runId: target.runId, events: [started], more: true, lastSequence: 4, lost: null, terminal: null }
    : unknownPage);
  t.after(() => partial.connection.dispose());
  assert.deepEqual(await partial.port.reconcile({ ...target, afterSequence: 0 }), { kind: 'events', events: [started], more: true });

  const lost = { fromSequence: 2, throughSequence: null, reason: 'restarted' };
  const restarted = setup(() => ({ ...unknownPage, lost }));
  t.after(() => restarted.connection.dispose());
  assert.deepEqual(await restarted.port.reconcile({ ...target, afterSequence: 1 }), { kind: 'lost', lost, terminal: null });
});

test('later replay failure keeps accepted events and leaves an explicit resumable cursor', async t => {
  let fail = true;
  const h = setup(request => {
    if (request.payload.afterSequence === 0) return { outcome: 'ok', runId: target.runId, events: [started], more: true, lastSequence: 4, lost: null, terminal: null };
    if (fail) throw new Error('invented unavailable replay');
    return { outcome: 'ok', runId: target.runId, events: [{ ...target, sequence: 2, at, type: 'text', text: 'Invented' },
      { ...target, sequence: 3, at, type: 'text', text: ' reply' }, terminal], more: false, lastSequence: 4, lost: null, terminal: null };
  });
  t.after(() => h.connection.dispose());
  assert.deepEqual(await h.port.reconcile({ ...target, afterSequence: 0 }), { kind: 'events', events: [started], more: true });
  fail = false;
  const resumed = await h.port.reconcile({ ...target, afterSequence: 1 });
  assert.equal(resumed.kind, 'events');
  if (resumed.kind === 'events') { assert.deepEqual(resumed.events.map(e => e.sequence), [2, 3, 4]); assert.equal(resumed.more, false); }
});

test('contradictory replay cursor and regressing page chronology never append contradictory evidence', async t => {
  const h = setup(request => ({ outcome: 'ok', runId: target.runId,
    events: request.payload.afterSequence === 0 ? [started] : [{ ...target, sequence: 2, at: '2026-10-10T11:59:59.000Z', type: 'text', text: 'Earlier clock' }],
    more: true, lastSequence: 4, lost: null, terminal: null }));
  t.after(() => h.connection.dispose());
  assert.deepEqual(await h.port.reconcile({ ...target, afterSequence: 0 }), { kind: 'events', events: [started], more: true });
  const invalid = setup(() => ({ outcome: 'ok', runId: target.runId, events: [], more: false, lastSequence: 1, lost: null, terminal: null }));
  t.after(() => invalid.connection.dispose());
  assert.deepEqual(await invalid.port.reconcile({ ...target, afterSequence: 2 }), { kind: 'unknown' });
});

test('replay stops at 64 pages with progress and bounds retained text before continuing', async t => {
  const h = setup(request => {
    const sequence = Number(request.payload.afterSequence) + 1;
    return { outcome: 'ok', runId: target.runId, events: [sequence === 1 ? started : { ...target, sequence, at, type: 'text', text: 'x' }],
      more: true, lastSequence: 1000, lost: null, terminal: null };
  });
  t.after(() => h.connection.dispose());
  const first = await h.port.reconcile({ ...target, afterSequence: 0 });
  assert.equal(first.kind, 'events');
  if (first.kind === 'events') { assert.equal(first.events.length, 64); assert.equal(first.more, true); }
  assert.equal(h.requests.length, 64);
  assert.equal(new Set(h.requests.map(r => r.requestId)).size, 64);
  const large = setup(request => {
    const after = Number(request.payload.afterSequence);
    return { outcome: 'ok', runId: target.runId, events: Array.from({ length: 32 }, (_, i) => ({ ...target,
      sequence: after + i + 1, at, type: 'text', text: 'x'.repeat(16_384) })), more: true, lastSequence: 1000, lost: null, terminal: null };
  });
  t.after(() => large.connection.dispose());
  const bounded = await large.port.reconcile({ ...target, afterSequence: 1 });
  assert.equal(bounded.kind, 'events');
  if (bounded.kind === 'events') {
    assert.equal(bounded.events.length, 16);
    assert.equal(bounded.more, true);
    assert.equal(bounded.events.at(-1)?.sequence, 17);
  }
});
