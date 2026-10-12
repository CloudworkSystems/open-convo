import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NATIVE_PROOF_LIMITS, NativeProofCodec, type NativeProofRequest } from '../../src/adapters/native-host-codec';
import { NATIVE_PARTICIPANT_OPERATIONS, decodeNativeParticipantPush } from '../../src/adapters/native-participant-codec';

// Invented immutable host vectors; no CLI, credentials or provider calls.
type Wire = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-participant-v1.json', import.meta.url), 'utf8')) as {
  context: { connectionId: string; documentGeneration: number };
  cases: { name: string; request: Wire; reply: Wire; [key: string]: unknown }[];
};
const sample = (name: string) => structuredClone(fixture.cases.find(entry => entry.name === name)!);
const contextOf = (request: Wire) => ({ connectionId: request.connectionId as string, documentGeneration: request.generation as number });
const requestOf = (wire: Wire): NativeProofRequest => ({ requestId: wire.requestId, operation: wire.operation, payload: wire.payload }) as NativeProofRequest;
const context = fixture.context;
const prepare = (codec: NativeProofCodec, wire: Wire) => {
  const prepared = codec.prepare(contextOf(wire), requestOf(wire));
  codec.register(prepared);
  return prepared;
};
const codecFor = (entry: { request: Wire }) => {
  const codec = new NativeProofCodec(contextOf(entry.request), 10);
  prepare(codec, entry.request);
  return codec;
};
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('every successful revision-3 fixture prepares and decodes the exact returned variant', () => {
  const successes = fixture.cases.filter(entry => entry.reply.outcome === 'ok');
  assert.ok(successes.length > 50);
  for (const entry of successes) {
    const codec = codecFor(entry);
    const result = codec.decode(JSON.stringify(entry.reply));
    assert.ok(result, entry.name);
    const { v: _v, requestId: _id, connectionId: _connection, generation: _generation, ...expected } = entry.reply;
    assert.deepEqual(result.result, expected, entry.name);
  }
});

test('all valid participant refusal and unknown fixtures decode without manufacturing success', () => {
  for (const entry of fixture.cases.filter(entry => entry.request.operation.startsWith('participant.') && entry.reply.outcome !== 'ok')) {
    const codec = codecFor(entry);
    const result = codec.decode(JSON.stringify(entry.reply));
    assert.equal(result?.result.outcome, entry.reply.outcome, entry.name);
    if (entry.reply.outcome === 'refused') assert.deepEqual(result?.result, {
      operation: entry.reply.operation, outcome: 'refused', reason: entry.reply.reason,
    }, entry.name);
  }
});

test('all eight new refusal reasons are exact known values, and participant conflicts/status unknown refuse', () => {
  const entry = sample('participant.status running');
  const codec = codecFor(entry);
  const { runId: _run, state: _state, lastSequence: _seq, terminal: _terminal, groupCleared: _clear, unknownReason: _reason, ...base } = entry.reply;
  for (const reason of ['run-not-found', 'run-not-prepared', 'run-mismatch', 'duplicate-run', 'unknown-run', 'participant-unavailable', 'participant-busy', 'participant-changed']) {
    assert.equal(codec.decode(JSON.stringify({ ...base, outcome: 'refused', reason }))?.result.outcome, 'refused');
  }
  for (const reply of [
    { ...base, outcome: 'refused', reason: 'invented-new-reason' }, { ...base, outcome: 'unknown' },
    { ...base, outcome: 'conflict', reason: 'revision-mismatch', revision: 1 },
  ]) assert.equal(codec.decode(JSON.stringify(reply)), undefined);
});

test('five participant names are optional advertised capabilities; legacy five and seven stay valid', () => {
  const entry = sample('host.capabilities on a participant host');
  const codec = codecFor(entry);
  const operations = entry.reply.capabilities.operations as string[];
  assert.equal(operations.length, 12);
  assert.ok(codec.decode(JSON.stringify(entry.reply)));
  for (const count of [5, 7]) {
    const reply = structuredClone(entry.reply); reply.capabilities.operations = operations.slice(0, count);
    assert.ok(codec.decode(JSON.stringify(reply)));
  }
  // A partial advertisement is readable, but the bootstrap must require all five before connection.
  const partial = structuredClone(entry.reply); partial.capabilities.operations = operations.slice(0, 8);
  assert.ok(codec.decode(JSON.stringify(partial)));
  for (const invalid of [[...operations, operations[7]], [...operations, 'participant.launch']]) {
    const reply = structuredClone(entry.reply); reply.capabilities.operations = invalid;
    assert.equal(codec.decode(JSON.stringify(reply)), undefined);
  }
});

test('commit claims have six exact fields, distinct identities, UTC time and no dictation correlation', () => {
  const entry = sample('workspace.commitProof prepares a run');
  assert.ok(codecFor(entry).decode(JSON.stringify(entry.reply)));
  const mutations: ((payload: Wire) => void)[] = [
    p => { p.participantRun.extra = true; }, p => { delete p.participantRun.createdAt; },
    p => { p.participantRun.createdAt = '2026-02-30T00:00:00.000Z'; }, p => { p.participantRun.runId = p.participantRun.runId.toUpperCase(); },
    p => { p.participantRun.userMessageId = p.participantRun.assistantMessageId; },
    p => { p.participantRun.sessionId = p.participantRun.runId.toUpperCase(); }, p => { p.participantRun.participantId = ''; },
    p => { p.dictationDeliveryId = id(2); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(entry.request); mutate(invalid.payload);
    assert.throws(() => prepare(new NativeProofCodec(context, 2), invalid));
  }
});

test('participant request identity and input bounds are strict and preserve UTF-8 chunks', () => {
  const entry = fixture.cases.find(item => item.request.operation === 'participant.start' && item.reply.outcome === 'ok')!;
  const mutations: ((payload: Wire) => void)[] = [
    p => { p.extra = 'bad'; }, p => { delete p.sessionId; }, p => { p.runId = p.sessionId; },
    p => { p.userMessageId = p.assistantMessageId; }, p => { p.participant.extra = true; },
    p => { p.participant.model = ' '; }, p => { p.participant.model = 'é'.repeat(129); },
    p => { p.inputChunks = []; }, p => { p.inputChunks = ['']; }, p => { p.inputChunks = ['\ud800']; },
    p => { p.inputChunks = ['é'.repeat(8193)]; }, p => { p.inputChunks = Array(17).fill('a'.repeat(16_384)); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(entry.request); mutate(invalid.payload);
    assert.throws(() => prepare(new NativeProofCodec(contextOf(entry.request), 1), invalid));
  }
  const eventRequest = sample('participant.events first page').request;
  for (const [key, value] of [['afterSequence', -1], ['afterSequence', 1.1], ['afterSequence', Number.MAX_SAFE_INTEGER + 1],
    ['maxEvents', 0], ['maxEvents', 65]]) {
    const invalid = structuredClone(eventRequest); invalid.payload[key] = value;
    assert.throws(() => prepare(new NativeProofCodec(contextOf(eventRequest), 1), invalid));
  }
});

test('all participant ok replies refuse missing, extra and unrelated run/session fields', () => {
  for (const operation of NATIVE_PARTICIPANT_OPERATIONS) {
    const entry = fixture.cases.find(item => item.reply.operation === operation && item.reply.outcome === 'ok')!;
    const codec = codecFor(entry);
    assert.equal(codec.decode(JSON.stringify({ ...entry.reply, extra: 1 })), undefined);
    for (const key of Object.keys(entry.reply).filter(key => !['v', 'requestId', 'connectionId', 'generation', 'operation', 'outcome'].includes(key))) {
      const changed = structuredClone(entry.reply); delete changed[key];
      assert.equal(codec.decode(JSON.stringify(changed)), undefined, `${operation} missing ${key}`);
    }
    if (operation !== 'participant.availability') assert.equal(codec.decode(JSON.stringify({ ...entry.reply, runId: id(999) })), undefined);
  }
  const entry = sample('participant.status returns the terminal when pushes failed');
  const codec = codecFor(entry);
  for (const key of ['runId', 'sessionId']) {
    const changed = structuredClone(entry.reply); changed.terminal[key] = id(999);
    assert.equal(codec.decode(JSON.stringify(changed)), undefined);
  }
});

test('availability requires exactly the native Claude pin and consistent display-only confirmation', () => {
  const entry = sample('participant.availability confirmation: active, confirmed this launch (test fake)');
  const codec = codecFor(entry);
  const mutations: ((p: Wire) => void)[] = [
    p => { p.id = 'another-provider'; }, p => { p.model = ''; }, p => { p.reason = 'overflow-unverified'; },
    p => { p.confirmation.state = 'unconfirmed'; delete p.confirmation.confirmedAt; delete p.confirmation.runsLeft; },
    p => { p.confirmation.runsLeft = 0; }, p => { p.confirmation.runsLeft = 6; }, p => { p.confirmation.runsLeft = 1.5; },
    p => { p.confirmation.confirmedAt = '2026-10-10'; }, p => { p.confirmation.accountId = 'forbidden'; },
    p => { p.confirmation = { state: 'ended', endedBy: 'invented' }; }, p => { p.confirmation = null; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(entry.reply); mutate(changed.participants[0]);
    assert.equal(codec.decode(JSON.stringify(changed)), undefined);
  }
  const two = structuredClone(entry.reply); two.participants.push(two.participants[0]);
  assert.equal(codec.decode(JSON.stringify(two)), undefined);
  for (const endedBy of ['lock', 'sleep', 'logout', 'cli-changed', 'login-changed', 'run-limit', 'paid-overflow']) {
    const changed = structuredClone(entry.reply); Object.assign(changed.participants[0], {
      available: false, reason: 'overflow-unverified', confirmation: { state: 'ended', endedBy },
    });
    assert.ok(codec.decode(JSON.stringify(changed)));
  }
});

test('availability refuses active confirmation with an overflow failure but preserves earlier failing checks', () => {
  const entry = sample('participant.availability confirmation: active, confirmed this launch (test fake)');
  const codec = codecFor(entry);
  const confirmations = [entry.reply.participants[0].confirmation, { state: 'unconfirmed' },
    { state: 'ended', endedBy: 'run-limit' }];
  for (const confirmation of confirmations) {
    for (const reason of ['cli-missing', 'cli-version-mismatch', 'provider-override', 'signed-out',
      'not-subscription', 'overflow-unverified', 'check-failed']) {
      const changed = structuredClone(entry.reply);
      Object.assign(changed.participants[0], { available: false, reason, confirmation });
      const result = codec.decode(JSON.stringify(changed));
      const contradictory = confirmation.state === 'active' && reason === 'overflow-unverified';
      assert.equal(Boolean(result), !contradictory, `${confirmation.state}: ${reason}`);
    }
  }
});

test('native events enforce exact reason/type pairs, sequence rules, Unicode and canonical time', () => {
  const common = { runId: id(1), sessionId: id(2), sequence: 2, at: '2026-10-09T00:01:01.000Z' };
  const push = (event: Wire) => decodeNativeParticipantPush(context, {
    type: 'participant.event', connectionId: context.connectionId, generation: context.documentGeneration, event,
  });
  for (const reason of ['local-stop', 'stop-incomplete']) assert.ok(push({ ...common, type: 'stopped', reason }));
  for (const reason of ['reply-too-long', 'paid-overflow', 'timeout', 'process-error']) assert.ok(push({ ...common, type: 'failed', reason }));
  for (const event of [
    { ...common, type: 'stopped', reason: 'paid-overflow' }, { ...common, type: 'failed', reason: 'local-stop' },
    { ...common, type: 'stopped' }, { ...common, type: 'failed' }, { ...common, type: 'completed', reason: 'local-stop' },
    { ...common, type: 'completed', sequence: 1 }, { ...common, type: 'started' }, { ...common, type: 'text', sequence: 1, text: 'x' },
    { ...common, type: 'text', text: '' }, { ...common, type: 'text', text: '\udfff' }, { ...common, type: 'text', text: 'é'.repeat(8193) },
    { ...common, type: 'completed', at: '2026-02-30T00:00:00.000Z' }, { ...common, type: 'completed', sequence: 1.5 },
    { ...common, type: 'completed', unknown: true },
  ]) assert.equal(push(event), undefined);
  assert.ok(push({ ...common, type: 'text', text: 'é'.repeat(8192) }));
  assert.ok(push({ ...common, sequence: 1, type: 'failed', reason: 'process-error' }));
});

test('push outer fields correlate document exactly and getters are rejected without execution', () => {
  const event = { runId: id(1), sessionId: id(2), sequence: 1, at: '2026-10-09T00:01:01.000Z', type: 'started' };
  const detail = { type: 'participant.event', connectionId: context.connectionId, generation: context.documentGeneration, event };
  assert.ok(decodeNativeParticipantPush(context, detail));
  for (const changed of [{ ...detail, extra: true }, { ...detail, generation: 999 }, { ...detail, connectionId: 'stale' },
    { ...detail, type: 'host.connection' }]) assert.equal(decodeNativeParticipantPush(context, changed), undefined);
  let calls = 0;
  const poisoned = Object.defineProperty({ ...detail }, 'event', { enumerable: true, get() { calls++; return event; } });
  assert.equal(decodeNativeParticipantPush(context, poisoned), undefined);
  assert.equal(decodeNativeParticipantPush(context, { ...detail, event: Object.defineProperty({ ...event }, 'at', {
    enumerable: true, get() { calls++; return event.at; },
  }) }), undefined);
  assert.equal(calls, 0);
  const accepted = decodeNativeParticipantPush(context, detail)!;
  event.type = 'completed'; assert.equal(accepted.type, 'started'); assert.ok(Object.isFrozen(accepted));
});

test('status and Stop preserve cleanup truth and refuse impossible state/result combinations', () => {
  const entry = sample('participant.status while an incomplete stop is cleaning up');
  const codec = codecFor(entry);
  for (const changed of [
    { ...entry.reply, groupCleared: true }, { ...entry.reply, terminal: null }, { ...entry.reply, unknownReason: 'exit-unrecorded' },
    { ...entry.reply, lastSequence: 2 }, { ...entry.reply, state: 'running' },
    { ...entry.reply, terminal: { ...entry.reply.terminal, reason: 'local-stop' } },
  ]) assert.equal(codec.decode(JSON.stringify(changed)), undefined);
  const unknown = sample('participant.status unknown after restart');
  assert.equal(codecFor(unknown).decode(JSON.stringify({ ...unknown.reply, unknownReason: null })), undefined);
  const stop = sample('participant.stop incomplete: the group survives SIGKILL');
  const stopCodec = codecFor(stop);
  for (const changed of [{ ...stop.reply, groupCleared: true }, { ...stop.reply, providerCancelConfirmed: true },
    { ...stop.reply, state: 'not-owned' }, { ...stop.reply, terminal: null }]) assert.equal(stopCodec.decode(JSON.stringify(changed)), undefined);
  // A historical false remains false even after ownership ends; it is not a codec error.
  assert.ok(stopCodec.decode(JSON.stringify({ ...stop.reply, state: 'exited' })));
});

test('status and Stop require cleanup evidence for stop-incomplete even before a started event', () => {
  for (const name of ['participant.status while an incomplete stop is cleaning up',
    'participant.stop incomplete: the group survives SIGKILL']) {
    const entry = sample(name);
    const codec = codecFor(entry);
    const sequenceOne: Wire = { ...entry.reply, state: 'exited', terminal: { ...entry.reply.terminal, sequence: 1 } };
    if (entry.request.operation === 'participant.status') sequenceOne.lastSequence = 1;
    assert.equal(codec.decode(JSON.stringify({ ...sequenceOne, groupCleared: null })), undefined, name);
    // Cleanup can stay unresolved, or clear later without rewriting the original terminal.
    for (const groupCleared of [false, true]) {
      assert.ok(codec.decode(JSON.stringify({ ...sequenceOne, groupCleared })), `${name}: ${groupCleared}`);
    }
    // A never-dispatched cancellation legitimately has no process group.
    assert.ok(codec.decode(JSON.stringify({ ...sequenceOne, groupCleared: null,
      terminal: { ...sequenceOne.terminal, reason: 'local-stop' } })), name);
  }
});

test('starting status has no event sequence before spawn', () => {
  const entry = sample('participant.status running');
  const codec = codecFor(entry);
  const starting = { ...entry.reply, state: 'starting', terminal: null, groupCleared: null, unknownReason: null };
  assert.ok(codec.decode(JSON.stringify({ ...starting, lastSequence: 0 })));
  for (const lastSequence of [1, 2, Number.MAX_SAFE_INTEGER]) {
    assert.equal(codec.decode(JSON.stringify({ ...starting, lastSequence })), undefined);
  }
});

test('event pages bind request cursor/maxEvents, monotonic time, contiguous sequence, terminal and lost range', () => {
  const entry = sample('participant.events first page');
  const codec = codecFor(entry);
  const mutations: ((reply: Wire) => void)[] = [
    p => { p.events[0].sequence++; }, p => { p.events[0].sessionId = id(999); }, p => { p.events.push(p.events[1]); },
    p => { p.more = false; }, p => { p.lastSequence = 1; }, p => { p.lastSequence = 0; }, p => { p.lastSequence = null; },
    p => { p.events[1].at = '2026-10-09T00:01:00.000Z'; }, p => { p.events[0] = { ...p.events[0], type: 'completed' }; delete p.events[0].text; },
    p => { p.events = []; }, p => { p.terminal = { ...p.events[1], type: 'completed' }; delete p.terminal.text; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(entry.reply); mutate(changed);
    assert.equal(codec.decode(JSON.stringify(changed)), undefined);
  }
  const lost = sample('participant.events lost after lock');
  const lostCodec = codecFor(lost);
  for (const mutate of [
    (p: Wire) => { p.lost.fromSequence++; }, (p: Wire) => { p.lost.throughSequence++; },
    (p: Wire) => { p.lost.reason = 'invented'; }, (p: Wire) => { p.more = true; },
    (p: Wire) => { p.terminal = null; }, (p: Wire) => { p.lastSequence++; },
  ]) {
    const changed = structuredClone(lost.reply); mutate(changed);
    assert.equal(lostCodec.decode(JSON.stringify(changed)), undefined);
  }
});

function clientHarness(timeout = 1_000, capacity = 4) {
  const sent: Wire[] = []; let receive!: (wire: string) => void;
  const transport: NativeHostTransport = { send(wire) { sent.push(JSON.parse(wire)); }, listen(reply) { receive = reply; return () => {}; } };
  const codec = new NativeProofCodec(context, capacity);
  const client = new NativeHostClient(transport, codec, { ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes,
    maxRetainedRequests: capacity, timeoutMs: timeout,
    operationTimeoutMs: Object.fromEntries(NATIVE_PARTICIPANT_OPERATIONS.map(operation => [operation, timeout])),
  });
  return { client, sent, reply: (value: Wire) => receive(JSON.stringify(value)) };
}

test('participant wire unknown completes immediately and never holds or releases a workspace barrier', async () => {
  const h = clientHarness();
  const commit = sample('workspace.commitProof prepares a run');
  const saving = h.client.request(requestOf(commit.request));
  const start = sample('participant.start unknown: start record write undetermined');
  assert.ok(start, 'fixture exists');
  const running = h.client.request(requestOf(start.request));
  h.reply(start.reply);
  assert.deepEqual(await running, { kind: 'completed', result: { operation: 'participant.start', outcome: 'unknown' } });
  const blocked = h.client.request({ ...requestOf(commit.request), requestId: id(500) });
  assert.deepEqual(await blocked, { kind: 'unavailable', reason: 'mutation-unresolved' });
  h.reply(commit.reply); assert.equal((await saving).kind, 'completed');
  h.client.revoke();
});

test('timed-out participant uncertainty is evictable and cannot resend through reconcile', async () => {
  const h = clientHarness(2, 1);
  const entry = sample('participant.status running');
  for (let n = 0; n < 6; n++) {
    const request = { ...requestOf(entry.request), requestId: id(n + 600) };
    assert.deepEqual(await h.client.request(request), { kind: 'unknown', reason: 'timeout' });
    assert.deepEqual(await h.client.reconcile(request.requestId), { kind: 'refused', reason: 'not-reconcilable' });
  }
  assert.equal(h.sent.length, 6); h.client.revoke();
});


test('cancelled and transport-failed participant calls release capacity without stopping native or replaying', async () => {
  for (const mode of ['cancelled', 'transport'] as const) {
    let sends = 0;
    const transport: NativeHostTransport = {
      send() { sends++; if (mode === 'transport') throw new Error('invented failure'); }, listen() { return () => {}; },
    };
    const client = new NativeHostClient(transport, new NativeProofCodec(context, 1), {
      ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 1, timeoutMs: 1_000,
    });
    for (let n = 0; n < 3; n++) {
      const abort = new AbortController();
      const request = { ...requestOf(sample('participant.status running').request), requestId: id(n + 700) };
      const pending = client.request(request, abort.signal);
      if (mode === 'cancelled') abort.abort();
      assert.deepEqual(await pending, { kind: 'unknown', reason: mode });
      assert.deepEqual(await client.reconcile(request.requestId), { kind: 'refused', reason: 'not-reconcilable' });
    }
    assert.equal(sends, 3); client.revoke();
  }
});

test('participant operations default to 20s start and 15s reads while workspace keeps configured timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Wire[] = [];
  const transport: NativeHostTransport = { send(wire) { sent.push(JSON.parse(wire)); }, listen() { return () => {}; } };
  const client = new NativeHostClient(transport, new NativeProofCodec(context, 4), {
    ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 4, timeoutMs: 500,
  });
  const start = fixture.cases.find(entry => entry.request.operation === 'participant.start' && entry.reply.outcome === 'ok')!;
  let startEnded = false; let statusEnded = false;
  const startPromise = client.request(requestOf(start.request)).then(result => { startEnded = true; return result; });
  const statusPromise = client.request(requestOf(sample('participant.status running').request)).then(result => { statusEnded = true; return result; });
  t.mock.timers.tick(14_999); await Promise.resolve(); assert.equal(startEnded, false); assert.equal(statusEnded, false);
  t.mock.timers.tick(1); await Promise.resolve(); assert.equal(statusEnded, true); assert.equal(startEnded, false);
  t.mock.timers.tick(5_000); assert.equal((await startPromise).kind, 'unknown'); assert.equal((await statusPromise).kind, 'unknown');
  assert.equal(sent.length, 2); client.revoke();
});
