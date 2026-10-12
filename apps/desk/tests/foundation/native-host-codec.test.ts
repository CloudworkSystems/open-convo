import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import {
  NATIVE_PROOF_LIMITS, NativeProofCodec, type NativeProofRequest, type NativeProofResult,
} from '../../src/adapters/native-host-codec';
import type { DeskState } from '../../src/domain/types';

// This fixed invented artifact is also available for the Swift host tests.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-host-v1.json', import.meta.url), 'utf8')) as {
  context: { connectionId: string; documentGeneration: number };
  cases: { name: string; request: Record<string, unknown>; reply: Record<string, unknown> }[];
};
const context = fixture.context;
const sample = (operation: string) => structuredClone(fixture.cases.find((entry) => entry.name === operation)!);
const request = (value: Record<string, unknown>): NativeProofRequest => ({
  requestId: value.requestId, operation: value.operation, payload: value.payload,
}) as NativeProofRequest;
const requestId = (n: number) => `71000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const commitSample = () => sample('workspace.commitProof');
const readSample = () => sample('workspace.read');
const commit = () => request(commitSample().request) as Extract<NativeProofRequest, { operation: 'workspace.commitProof' }>;
const read = () => request(readSample().request);
const validRecord = () => structuredClone(readSample().reply.record) as DeskState;
// Pure-codec tests explicitly cross the same accepted-dispatch boundary as the client.
const prepare = (codec: NativeProofCodec, value: NativeProofRequest) => {
  const prepared = codec.prepare(context, value);
  codec.register(prepared);
  return prepared;
};

test('shared invented native v1 fixtures prepare and decode all five agreed operations', () => {
  const codec = new NativeProofCodec(context, fixture.cases.length);
  for (const entry of fixture.cases) {
    const prepared = prepare(codec, request(entry.request));
    assert.deepEqual(JSON.parse(prepared.wire), entry.request);
    const decoded = codec.decode(JSON.stringify(entry.reply));
    assert.equal(decoded?.operation, entry.request.operation);
    assert.equal(decoded?.requestId, entry.request.requestId);
    assert.equal(decoded?.connectionId, context.connectionId);
    assert.equal(decoded?.documentGeneration, context.documentGeneration);
    assert.equal(decoded?.result.outcome, 'ok');
  }
  codec.revoke();
});

test('shared vectors expose canonical UUID case changes and include a correlated dictation commit', () => {
  for (const entry of fixture.cases) assert.match(entry.request.requestId as string, /[a-f]/);
  const binding = sample('dictation.bindDraft').reply.bindingId as string;
  assert.match(binding, /[a-f]/);
  const state = validRecord();
  assert.match(state.sessions[0].id, /[a-f]/);
  assert.equal(state.goals[0].id, 'A1000000-0000-1000-8000-000000000001');
  const correlated = sample('workspace.commitProof with dictation delivery');
  const payload = correlated.request.payload as Record<string, unknown>;
  assert.equal(payload.dictationDeliveryId, '58abcdef-0000-4000-8abc-000000000001');
  const codec = new NativeProofCodec(context, 1);
  const prepared = prepare(codec, request(correlated.request));
  assert.deepEqual(JSON.parse(prepared.wire), correlated.request);
  assert.equal(codec.decode(JSON.stringify(correlated.reply))?.result.outcome, 'ok');
});

test('existing UUID versions and case are preserved while request and native binding IDs are canonical UUIDv4', () => {
  const codec = new NativeProofCodec(context, 8);
  const original = commit();
  const prepared = prepare(codec, original);
  const copied = JSON.parse(prepared.wire).payload.record as DeskState;
  assert.equal(copied.goals[0].id, 'A1000000-0000-1000-8000-000000000001');
  assert.equal(copied.sessions[0].goalId, copied.goals[0].id);
  for (const invalidId of ['A1000000-0000-1000-8000-000000000001', 'A1000000-0000-4000-8000-000000000001', 'not-an-id']) {
    assert.throws(() => prepare(codec, { ...original, requestId: invalidId }), TypeError);
    const unbind = request(sample('dictation.unbindDraft').request);
    assert.throws(() => prepare(codec, { ...unbind, payload: { bindingId: invalidId } } as NativeProofRequest), TypeError);
  }
  const binding = request(sample('dictation.bindDraft').request);
  assert.doesNotThrow(() => prepare(codec, { ...binding, payload: { ...binding.payload, sessionId: copied.goals[0].id } } as NativeProofRequest));
});

test('connection and workspace handles remain bounded opaque strings, not claims of native authentication', () => {
  const opaqueContext = { connectionId: 'invented-issued-connection', documentGeneration: 0 };
  const codec = new NativeProofCodec(opaqueContext, 1);
  const value = { ...read(), payload: { workspaceHandle: 'invented-issued-handle' } } as NativeProofRequest;
  const prepared = codec.prepare(opaqueContext, value);
  assert.equal(JSON.parse(prepared.wire).connectionId, opaqueContext.connectionId);
  assert.throws(() => codec.prepare({ ...opaqueContext, documentGeneration: 1 }, value), TypeError);
  assert.throws(() => new NativeProofCodec({ ...opaqueContext, connectionId: '' }, 1), TypeError);
  assert.throws(() => new NativeProofCodec({ ...opaqueContext, connectionId: 'x'.repeat(65_537) }, 1), TypeError);
});

test('request field sets and unsupported verbs refuse before serialization without echoing payloads', () => {
  const codec = new NativeProofCodec(context, 10);
  const base = commit();
  const wrong: unknown[] = [
    { ...base, privateField: 'private canary' },
    { ...base, payload: { ...base.payload, privateField: 'private canary' } },
    { ...base, operation: 'provider.send' },
    { ...base, operation: 'dictation.finalReceipt' },
    { ...base, payload: { ...base.payload, expectedRevision: null } },
    { ...base, payload: [] },
    { ...read(), payload: {} },
    { ...request(sample('host.capabilities').request), payload: { path: '/invented' } },
  ];
  for (const value of wrong) {
    assert.throws(() => prepare(codec, value as NativeProofRequest), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'The native proof request is invalid or unavailable.');
      return true;
    });
  }
});

test('commits and reads reject incompatible DeskState instead of stripping fields or accepting private mode', () => {
  const corruptions: ((state: DeskState) => void)[] = [
    (state) => { state.sessions[0].goalId = '51000000-0000-4000-8000-000000000099'; },
    (state) => { state.messages[0].id = state.sessions[0].id; },
    (state) => { state.capabilities.provider = 'real-provider' as 'demo-only'; },
    (state) => { (state as unknown as Record<string, unknown>).extra = 'private canary'; },
    (state) => { state.updatedAt = 'yesterday'; },
  ];
  for (const corrupt of corruptions) {
    const codec = new NativeProofCodec(context, 2);
    const value = commit();
    corrupt(value.payload.record);
    const before = structuredClone(value);
    assert.throws(() => prepare(codec, value), TypeError);
    assert.deepEqual(value, before);
    prepare(codec, read());
    const reply = readSample().reply;
    const state = validRecord();
    corrupt(state);
    assert.equal(codec.decode(JSON.stringify({ ...reply, record: state })), undefined);
  }
});

test('valid noncyclic shared draft objects serialize as independent JSON values without changing the caller', () => {
  const codec = new NativeProofCodec(context, 1);
  const value = commit();
  const state = value.payload.record;
  const firstGoal = state.goals[0].id;
  const secondGoal = requestId(500);
  state.goals.push({ ...state.goals[0], id: secondGoal, title: 'Second invented folder' });
  state.goalDrafts[secondGoal] = state.goalDrafts[firstGoal];
  const prepared = prepare(codec, value);
  const serialized = JSON.parse(prepared.wire).payload.record as DeskState;
  assert.strictEqual(state.goalDrafts[firstGoal], state.goalDrafts[secondGoal]);
  assert.notStrictEqual(serialized.goalDrafts[firstGoal], serialized.goalDrafts[secondGoal]);
  assert.deepEqual(serialized.goalDrafts[firstGoal], serialized.goalDrafts[secondGoal]);
});

test('revision gaps are valid, but commit success must equal the attempted snapshot revision', () => {
  const codec = new NativeProofCodec(context, 4);
  const value = commit();
  assert.equal(value.payload.expectedRevision, 1);
  assert.equal(value.payload.record.revision, 3);
  prepare(codec, value);
  const reply = commitSample().reply;
  for (const revision of [1, 2, 4, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.equal(codec.decode(JSON.stringify({ ...reply, revision })), undefined);
  }
  assert.equal(codec.decode(JSON.stringify(reply))?.result.outcome, 'ok');
  for (const [index, revision] of [0, 1, -1, Number.MAX_SAFE_INTEGER + 1].entries()) {
    const invalid = commit();
    const fresh = { ...invalid, requestId: requestId(1000 + index) };
    fresh.payload.record.revision = revision;
    assert.throws(() => prepare(codec, fresh), TypeError);
  }
  const reading = readSample();
  prepare(codec, request(reading.request));
  assert.equal(codec.decode(JSON.stringify({ ...reading.reply, revision: 2 })), undefined);
});

test('draft bind uses UTF-16 selections without splitting surrogate pairs and matches its captured revision', () => {
  const codec = new NativeProofCodec(context, 4);
  const entry = sample('dictation.bindDraft');
  const value = request(entry.request) as Extract<NativeProofRequest, { operation: 'dictation.bindDraft' }>;
  prepare(codec, value);
  assert.equal(codec.decode(JSON.stringify(entry.reply))?.result.outcome, 'ok');
  assert.equal(codec.decode(JSON.stringify({ ...entry.reply, revision: 4 })), undefined);
  for (const selection of [{ start: 8, end: 9 }, { start: 7, end: 8 }, { start: 9, end: 7 }, { start: 0, end: 100 }, { start: -1, end: 0 }, { start: 0.5, end: 1 }]) {
    assert.throws(() => prepare(codec, { ...value, payload: { ...value.payload, selection } }), TypeError);
  }
  assert.throws(() => prepare(codec, { ...value, payload: { ...value.payload, expectedRevision: Number.MAX_SAFE_INTEGER } }), TypeError);
});

test('text limits count UTF-8 bytes and preserve text rather than truncating it', () => {
  const codec = new NativeProofCodec(context, 3);
  const value = commit();
  const session = value.payload.record.sessions[0].id;
  value.payload.record.drafts[session] = '😀'.repeat(NATIVE_PROOF_LIMITS.textItemBytes / 4);
  assert.doesNotThrow(() => prepare(codec, value));
  value.payload.record.drafts[session] += 'a';
  assert.throws(() => prepare(codec, value), TypeError);
  assert.equal(value.payload.record.drafts[session].length, 32_769);
  const binding = request(sample('dictation.bindDraft').request) as Extract<NativeProofRequest, { operation: 'dictation.bindDraft' }>;
  assert.throws(() => prepare(codec, { ...binding, payload: { ...binding.payload, expectedText: '😀'.repeat(16_385) } }), TypeError);
});

test('lone UTF-16 surrogates refuse instead of measuring or transmitting replacement characters', () => {
  const codec = new NativeProofCodec(context, 5);
  prepare(codec, read());
  for (const malformed of ['\ud800', '\udfff', 'before\ud800after', '\ud800\ud800', '\udfff\ud800']) {
    const value = commit();
    value.payload.record.drafts[value.payload.record.sessions[0].id] = malformed;
    assert.throws(() => codec.prepare(context, value), TypeError);
    const badRecord = validRecord();
    badRecord.drafts[badRecord.sessions[0].id] = malformed;
    assert.equal(codec.decode(JSON.stringify({ ...readSample().reply, record: badRecord })), undefined);
    const bind = request(sample('dictation.bindDraft').request) as Extract<NativeProofRequest, { operation: 'dictation.bindDraft' }>;
    assert.throws(() => codec.prepare(context, { ...bind, payload: { ...bind.payload, expectedText: malformed, selection: { start: 0, end: 0 } } }), TypeError);
  }
  for (const valid of ['\ud800\udc00', '😀', 'before 😀 after', '\ufffd']) {
    const value = commit();
    value.payload.record.drafts[value.payload.record.sessions[0].id] = valid;
    assert.doesNotThrow(() => codec.prepare(context, value));
  }
});

test('record and full envelope limits are independently enforced before decoding or dispatch', () => {
  const codec = new NativeProofCodec(context, 2);
  const value = commit();
  const original = value.payload.record.notes[0];
  value.payload.record.notes = Array.from({ length: 17 }, (_, n) => ({ ...original, id: requestId(100 + n), body: 'a'.repeat(65_536) }));
  assert.throws(() => prepare(codec, value), TypeError);
  prepare(codec, read());
  assert.equal(codec.decode(JSON.stringify({ ...readSample().reply, record: value.payload.record })), undefined);
  assert.equal(codec.decode(' '.repeat(NATIVE_PROOF_LIMITS.envelopeBytes + 1)), undefined);
  const oversizedEnvelope = { ...readSample().reply, extra: 'x'.repeat(NATIVE_PROOF_LIMITS.envelopeBytes) };
  assert.equal(codec.decode(JSON.stringify(oversizedEnvelope)), undefined);
});

test('a record one byte over its own limit refuses inside an otherwise valid smaller envelope', () => {
  const codec = new NativeProofCodec(context, 2);
  const value = commit();
  const original = value.payload.record.notes[0];
  value.payload.record.notes = Array.from({ length: 16 }, (_, n) => ({ ...original, id: requestId(300 + n), body: 'a'.repeat(65_536) }));
  const excess = Buffer.byteLength(JSON.stringify(value.payload.record), 'utf8') - (NATIVE_PROOF_LIMITS.recordBytes + 1);
  assert.ok(excess > 0 && excess < 65_536);
  value.payload.record.notes.at(-1)!.body = 'a'.repeat(65_536 - excess);
  assert.equal(Buffer.byteLength(JSON.stringify(value.payload.record), 'utf8'), NATIVE_PROOF_LIMITS.recordBytes + 1);
  assert.ok(value.payload.record.notes.every((note) => Buffer.byteLength(note.body, 'utf8') <= NATIVE_PROOF_LIMITS.textItemBytes));
  const otherwiseValidRequest = JSON.stringify({ ...commitSample().request, payload: value.payload });
  assert.ok(Buffer.byteLength(otherwiseValidRequest, 'utf8') < NATIVE_PROOF_LIMITS.envelopeBytes);
  assert.throws(() => codec.prepare(context, value), TypeError);
  prepare(codec, read());
  const otherwiseValidReply = JSON.stringify({ ...readSample().reply, revision: value.payload.record.revision, record: value.payload.record });
  assert.ok(Buffer.byteLength(otherwiseValidReply, 'utf8') < NATIVE_PROOF_LIMITS.envelopeBytes);
  assert.equal(codec.decode(otherwiseValidReply), undefined);
});

test('decode envelope ceiling rejects a reply whose parsed fields are otherwise completely valid', () => {
  const codec = new NativeProofCodec(context, 1);
  prepare(codec, read());
  const valid = JSON.stringify(readSample().reply);
  const oversized = valid + ' '.repeat(NATIVE_PROOF_LIMITS.envelopeBytes + 1 - Buffer.byteLength(valid, 'utf8'));
  assert.equal(Buffer.byteLength(oversized, 'utf8'), NATIVE_PROOF_LIMITS.envelopeBytes + 1);
  assert.deepEqual(JSON.parse(oversized), JSON.parse(valid));
  assert.ok(codec.decode(JSON.stringify(JSON.parse(oversized))), 'The parsed content is valid without the excess wire whitespace.');
  assert.equal(codec.decode(oversized), undefined);
});

test('capabilities must match the agreed operation set and exact proof limits', () => {
  const codec = new NativeProofCodec(context, 1);
  const entry = sample('host.capabilities');
  prepare(codec, request(entry.request));
  const good = entry.reply.capabilities as Record<string, unknown>;
  for (const bad of [
    { ...good, provider: 'enabled' }, { ...good, contractVersion: 2 }, { ...good, store: 'initialized-empty' },
    { ...good, operations: ['workspace.read'] }, { ...good, operations: ['host.capabilities', 'workspace.read', 'workspace.commitProof', 'dictation.bindDraft', 'provider.send'] },
    { ...good, operations: ['host.capabilities', 'workspace.read', 'workspace.commitProof', 'dictation.bindDraft', 'dictation.bindDraft'] },
    { ...good, limits: { ...NATIVE_PROOF_LIMITS, outstandingMutations: 2 } },
    { ...good, limits: { ...NATIVE_PROOF_LIMITS, extra: 1 } },
  ]) assert.equal(codec.decode(JSON.stringify({ ...entry.reply, capabilities: bad })), undefined);
  const unavailable = { ...good, store: 'corrupt', lock: 'locked' };
  const decoded = codec.decode(JSON.stringify({ ...entry.reply, capabilities: unavailable }));
  assert.equal(decoded?.result.outcome, 'ok', 'Capabilities report locked/corrupt honestly; they do not grant access.');
  const advertised = { ...good, operations: [...good.operations as string[], 'workspace.reconcile', 'dictation.receipt'] };
  assert.equal(codec.decode(JSON.stringify({ ...entry.reply, capabilities: advertised }))?.result.outcome, 'ok');
  for (const operation of ['workspace.reconcile', 'dictation.receipt']) {
    assert.throws(() => prepare(codec, { ...request(entry.request), operation } as NativeProofRequest), TypeError,
      'Advertising an agreed name does not enable an unimplemented request variant.');
  }
});

test('each operation refuses extra and missing reply fields', () => {
  const codec = new NativeProofCodec(context, fixture.cases.length);
  for (const entry of fixture.cases) {
    prepare(codec, request(entry.request));
    assert.equal(codec.decode(JSON.stringify({ ...entry.reply, unknownField: true })), undefined);
    for (const key of Object.keys(entry.reply)) {
      const missing = { ...entry.reply };
      delete missing[key];
      assert.equal(codec.decode(JSON.stringify(missing)), undefined, `${entry.name} missing ${key}`);
    }
  }
});

test('a maximal record fits its own ceiling but an oversized complete envelope still refuses', () => {
  const codec = new NativeProofCodec(context, 2);
  const value = commit();
  const original = value.payload.record.notes[0];
  value.payload.record.notes = Array.from({ length: 16 }, (_, n) => ({ ...original, id: requestId(200 + n), body: 'a'.repeat(65_536) }));
  const over = Buffer.byteLength(JSON.stringify(value.payload.record), 'utf8') - NATIVE_PROOF_LIMITS.recordBytes;
  assert.ok(over > 0 && over < 65_536);
  value.payload.record.notes.at(-1)!.body = 'a'.repeat(65_536 - over);
  assert.equal(Buffer.byteLength(JSON.stringify(value.payload.record), 'utf8'), NATIVE_PROOF_LIMITS.recordBytes);
  assert.doesNotThrow(() => prepare(codec, value));
  const tooWide = { ...value, payload: { ...value.payload, workspaceHandle: 'x'.repeat(65_536) } };
  assert.throws(() => prepare(codec, tooWide), TypeError);
  assert.equal(value.payload.record.notes.at(-1)!.body.length, 65_536 - over);
});

test('only known requests and matching operation, connection and generation can complete', () => {
  const codec = new NativeProofCodec(context, 2);
  prepare(codec, commit());
  const reply = commitSample().reply;
  for (const bad of [
    { ...reply, v: 2 }, { ...reply, requestId: requestId(999) }, { ...reply, connectionId: 'other' },
    { ...reply, generation: 3 }, { ...reply, operation: 'workspace.read' }, { ...reply, unexpected: true },
    { ...reply, record: validRecord() }, { ...reply, receipt: 'accepted' }, { ...reply, outcome: 'received' },
  ]) assert.equal(codec.decode(JSON.stringify(bad)), undefined);
  for (const bad of ['not-json', 'null', '[]', 'true', '{}']) assert.equal(codec.decode(bad), undefined);
  assert.equal(codec.decode(JSON.stringify(reply))?.result.outcome, 'ok');
});

test('refusals and conflicts use fixed reasons and exact fields', () => {
  const codec = new NativeProofCodec(context, 1);
  prepare(codec, commit());
  const { revision: _revision, ...base } = commitSample().reply;
  const refused = { ...base, outcome: 'refused', reason: 'store-locked' };
  assert.deepEqual(codec.decode(JSON.stringify(refused))?.result, { operation: 'workspace.commitProof', outcome: 'refused', reason: 'store-locked' });
  assert.equal(codec.decode(JSON.stringify({ ...refused, reason: 'Private error detail' })), undefined);
  assert.equal(codec.decode(JSON.stringify({ ...refused, revision: 3 })), undefined);
  const conflict = { ...base, outcome: 'conflict', revision: 5, reason: 'revision-mismatch' };
  assert.equal(codec.decode(JSON.stringify(conflict))?.result.outcome, 'conflict');
  assert.equal(codec.decode(JSON.stringify({ ...conflict, reason: 'store-locked' })), undefined);
  assert.equal(codec.decode(JSON.stringify({ ...conflict, record: validRecord() })), undefined);
});

test('all 24 agreed native refusal reasons decode, including unknown request and delivery', () => {
  const agreed = [
    'unknown-connection', 'stale-generation', 'unknown-operation', 'malformed-envelope', 'unknown-field',
    'unsupported-version', 'payload-too-large', 'text-too-large', 'payload-mismatch', 'mutation-outstanding',
    'invalid-identity', 'invalid-revision', 'revision-not-advanced', 'revision-mismatch', 'store-missing',
    'store-corrupt', 'store-locked', 'unknown-handle', 'unknown-binding', 'binding-stale', 'duplicate-delivery', 'locked',
    'unknown-delivery', 'unknown-request',
  ];
  assert.equal(new Set(agreed).size, 24);
  const codec = new NativeProofCodec(context, 1);
  prepare(codec, commit());
  const { revision: _revision, ...base } = commitSample().reply;
  for (const reason of agreed) {
    assert.deepEqual(codec.decode(JSON.stringify({ ...base, outcome: 'refused', reason }))?.result,
      { operation: 'workspace.commitProof', outcome: 'refused', reason });
  }
});

test('optional dictation delivery correlation accepts only canonical UUIDv4 and preserves the exact wire', () => {
  const codec = new NativeProofCodec(context, 1);
  const value = commit();
  for (const dictationDeliveryId of [undefined, '', '58ABCDEF-0000-4000-8ABC-000000000001', '58abcdef-0000-1000-8abc-000000000001', 'unknown']) {
    assert.throws(() => codec.prepare(context, { ...value, payload: { ...value.payload, dictationDeliveryId } }), TypeError);
  }
  const correlated = { ...value, payload: { ...value.payload, dictationDeliveryId: '58abcdef-0000-4000-8abc-000000000001' } };
  const prepared = prepare(codec, correlated);
  assert.equal(JSON.parse(prepared.wire).payload.dictationDeliveryId, correlated.payload.dictationDeliveryId);
});

test('preparation is pure; registration validates accepted envelope metadata and cannot consume capacity on refusal', () => {
  const codec = new NativeProofCodec(context, 1);
  const prepared = codec.prepare(context, commit());
  assert.equal(codec.decode(JSON.stringify(commitSample().reply)), undefined);
  for (let n = 0; n < 30; n++) codec.prepare(context, { ...commit(), requestId: requestId(2000 + n) });
  for (const invalid of [
    { ...prepared, requestId: requestId(999) },
    { ...prepared, operation: 'workspace.read' as const },
    { ...prepared, wire: JSON.stringify({ ...JSON.parse(prepared.wire), generation: 99 }) },
    { ...prepared, wire: JSON.stringify({ ...JSON.parse(prepared.wire), extra: 'unexpected' }) },
  ]) assert.throws(() => codec.register(invalid), TypeError);
  codec.register(prepared);
  assert.equal(codec.decode(JSON.stringify(commitSample().reply))?.result.outcome, 'ok');
  const unused = codec.prepare(context, read());
  assert.throws(() => codec.register(unused), TypeError);
  assert.doesNotThrow(() => codec.register(prepared));
  codec.revoke();
  assert.throws(() => codec.register(prepared), TypeError);
});

test('codec keeps immutable bounded metadata until explicit lifecycle release and revokes permanently', () => {
  const codec = new NativeProofCodec(context, 1);
  const value = commit();
  const prepared = prepare(codec, value);
  const expectedWire = prepared.wire;
  value.payload.record.revision = 8;
  value.payload.record.drafts[value.payload.record.sessions[0].id] = 'Later text';
  assert.equal(prepared.wire, expectedWire);
  assert.throws(() => prepare(codec, value), TypeError);
  assert.equal(codec.decode(JSON.stringify(commitSample().reply))?.result.outcome, 'ok');
  assert.throws(() => prepare(codec, read()), TypeError);
  assert.doesNotThrow(() => prepare(codec, commit()));
  codec.forget(value.requestId);
  assert.equal(codec.decode(JSON.stringify(commitSample().reply)), undefined);
  assert.doesNotThrow(() => prepare(codec, read()));
  codec.revoke();
  codec.revoke();
  assert.equal(codec.decode(JSON.stringify(commitSample().reply)), undefined);
  assert.throws(() => prepare(codec, commit()), TypeError);
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new NativeProofCodec(context, limit), TypeError);
});

class Transport implements NativeHostTransport {
  readonly wires: string[] = [];
  reply = (_wire: string) => {};
  revoked = () => {};
  listen(reply: (wire: string) => void, revoked: () => void) {
    this.reply = reply;
    this.revoked = revoked;
    return () => {};
  }
  send(wire: string) { this.wires.push(wire); }
}

test('more than 300 completed commits keep client and codec retention bounded without stopping new saves', async () => {
  const limit = 8;
  const codec = new NativeProofCodec(context, limit);
  const transport = new Transport();
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec, {
    ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: limit, timeoutMs: 60_000,
  });
  const replies: string[] = [];
  let last: NativeProofRequest | undefined;
  for (let n = 0; n < 320; n++) {
    const state = validRecord();
    state.revision = n + 1;
    state.drafts[state.sessions[0].id] = `Invented committed text ${n}`;
    const value: NativeProofRequest = { requestId: requestId(7000 + n), operation: 'workspace.commitProof',
      payload: { workspaceHandle: 'invented-workspace-handle', expectedRevision: n, record: state } };
    const pending = client.request(value);
    const reply = JSON.stringify({ ...commitSample().reply, requestId: value.requestId, revision: state.revision });
    replies.push(reply);
    transport.reply(reply);
    assert.equal((await pending).kind, 'completed', `Commit ${n} must not hit lifetime capacity.`);
    last = value;
  }
  assert.equal(transport.wires.length, 320);
  assert.equal(replies.filter((reply) => codec.decode(reply) !== undefined).length, limit,
    'Codec metadata is released with the same completed identities as the client cache.');
  assert.deepEqual(await client.reconcile(requestId(7000)), { kind: 'refused', reason: 'not-reconcilable' });
  const before = transport.wires.length;
  assert.equal((await client.request(last!)).kind, 'completed');
  assert.equal(transport.wires.length, before);
  const changed = structuredClone(last!) as Extract<NativeProofRequest, { operation: 'workspace.commitProof' }>;
  changed.payload.record.drafts[changed.payload.record.sessions[0].id] = 'Changed identity payload';
  assert.deepEqual(await client.request(changed), { kind: 'refused', reason: 'identity-reused' });
  const live = { ...commit(), requestId: requestId(8000) };
  const pending = client.request(live);
  transport.reply(replies[0]);
  assert.deepEqual(await client.request({ ...commit(), requestId: requestId(8001) }), { kind: 'unavailable', reason: 'mutation-unresolved' });
  transport.reply(JSON.stringify({ ...commitSample().reply, requestId: live.requestId }));
  assert.equal((await pending).kind, 'completed');
  client.revoke();
  codec.revoke();
});

test('blocked and cancelled preparations do not consume codec slots needed by actually dispatched requests', async () => {
  const codec = new NativeProofCodec(context, 5);
  const transport = new Transport();
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec, {
    ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 5, timeoutMs: 60_000,
  });
  const first = client.request(commit());
  const cancelled = new AbortController();
  cancelled.abort();
  for (let n = 0; n < 50; n++) {
    assert.deepEqual(await client.request({ ...commit(), requestId: requestId(3000 + n) }), { kind: 'unavailable', reason: 'mutation-unresolved' });
    assert.deepEqual(await client.request({ ...read(), requestId: requestId(4000 + n) }, cancelled.signal), { kind: 'refused', reason: 'cancelled-before-send' });
  }
  for (let n = 0; n < 4; n++) {
    const value = { ...read(), requestId: requestId(5000 + n) };
    const pending = client.request(value);
    transport.reply(JSON.stringify({ ...readSample().reply, requestId: value.requestId }));
    assert.equal((await pending).kind, 'completed');
  }
  assert.equal(transport.wires.length, 5);
  const nextId = requestId(6000);
  const next = client.request({ ...read(), requestId: nextId });
  transport.reply(JSON.stringify({ ...readSample().reply, requestId: nextId }));
  assert.equal((await next).kind, 'completed');
  assert.equal(transport.wires.length, 6);
  transport.reply(JSON.stringify(commitSample().reply));
  assert.equal((await first).kind, 'completed');
  client.revoke();
  codec.revoke();
});

test('native unknown and receipt-like replies preserve the real lifecycle mutation barrier until a durable result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const codec = new NativeProofCodec(context, 5);
  const transport = new Transport();
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec, {
    ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 5, timeoutMs: 100,
  });
  const value = commit();
  const pending = client.request(value);
  const { revision: _revision, ...base } = commitSample().reply;
  transport.reply(JSON.stringify({ ...base, outcome: 'unknown' }));
  transport.reply(JSON.stringify({ ...base, outcome: 'unknown', receipt: 'received' }));
  transport.reply(JSON.stringify({ ...base, outcome: 'ok', receipt: 'received' }));
  const another = { ...commit(), requestId: requestId(9) };
  assert.deepEqual(await client.request(another), { kind: 'unavailable', reason: 'mutation-unresolved' });
  t.mock.timers.tick(100);
  assert.deepEqual(await pending, { kind: 'unknown', reason: 'timeout' });
  const reconciliation = client.reconcile(value.requestId);
  assert.equal(transport.wires[1], transport.wires[0]);
  transport.reply(JSON.stringify(commitSample().reply));
  assert.deepEqual(await reconciliation, { kind: 'completed', result: { operation: 'workspace.commitProof', outcome: 'ok', revision: 3 } });
  codec.revoke();
  client.revoke();
});
