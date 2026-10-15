import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeProofCodec, type NativeProofRequest } from '../../src/adapters/native-host-codec';
import { createConversationRun, freezeConversationRun, validateConversationRun, LOCAL_PARTICIPANT_ID, MAX_CONTEXT_RUNS } from '../../src/domain/conversation-runs';

// Revision 4 (contract section 20): invented local-model vectors, page side only.
type Wire = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-participant-local-v1.json', import.meta.url), 'utf8')) as {
  context: { localParticipant: Wire };
  cases: { name: string; request: Wire; reply: Wire }[];
  invalidReplies: { name: string; basedOn: string; reply: Wire }[];
  runs: { valid: { name: string; run: Wire }[]; invalid: { name: string; run: Wire }[] };
};
const v3 = JSON.parse(readFileSync(new URL('../fixtures/native-participant-v1.json', import.meta.url), 'utf8')) as {
  cases: { name: string; request: Wire; reply: Wire }[];
};
const contextOf = (request: Wire) => ({ connectionId: request.connectionId as string, documentGeneration: request.generation as number });
const codecFor = (request: Wire) => {
  const codec = new NativeProofCodec(contextOf(request), 10);
  const prepared = codec.prepare(contextOf(request), { requestId: request.requestId, operation: request.operation, payload: request.payload } as NativeProofRequest);
  codec.register(prepared);
  return codec;
};
const strip = ({ v: _v, requestId: _id, connectionId: _c, generation: _g, ...rest }: Wire) => rest;

test('every local-route fixture prepares and decodes to its exact result', () => {
  assert.equal(fixture.cases.length, 6);
  for (const entry of fixture.cases) {
    const result = codecFor(entry.request).decode(JSON.stringify(entry.reply));
    assert.ok(result, entry.name);
    assert.deepEqual(result.result, strip(entry.reply), entry.name);
  }
});

test('the Claude Code entry stays first and typed as section 5 with a local route', () => {
  const entry = fixture.cases[0];
  const result = codecFor(entry.request).decode(JSON.stringify(entry.reply))!.result as Wire;
  assert.equal(result.participants[0].id, 'claude-code');
  assert.deepEqual(result.participants.slice(1).map((p: Wire) => p.label), ['invented-cloud:cloud', 'invented-local-large:9b', 'invented-local-small:7b']);
  assert.equal(result.participants[1].available, false);
  assert.equal(result.participants[1].reason, 'model-not-local');
  assert.deepEqual(result.routes, [{ route: 'ollama-local', state: 'ready', reason: null }]);
});

test('the page codec refuses every malformed local-route reply', () => {
  assert.ok(fixture.invalidReplies.length >= 19);
  for (const entry of fixture.invalidReplies) {
    const base = fixture.cases.find(c => c.name === entry.basedOn)!;
    assert.equal(codecFor(base.request).decode(JSON.stringify(entry.reply)), undefined, entry.name);
  }
});

test('revision-3 availability without routes still requires exactly one Claude entry', () => {
  const entry = structuredClone(v3.cases.find(c => c.name === 'participant.availability available (test fake)')!);
  assert.ok(codecFor(entry.request).decode(JSON.stringify(entry.reply)));
  const local = fixture.cases[0].reply.participants[2];
  entry.reply.participants.push(local);
  assert.equal(codecFor(entry.request).decode(JSON.stringify(entry.reply)), undefined);
});

test('prepared local runs carry contextRunIds exactly when the participant is local', () => {
  assert.equal(LOCAL_PARTICIPANT_ID, 'ollama-local');
  assert.equal(MAX_CONTEXT_RUNS, 256);
  for (const entry of fixture.runs.valid) {
    assert.equal(validateConversationRun(structuredClone(entry.run)), true, entry.name);
    const frozen = freezeConversationRun(structuredClone(entry.run));
    assert.equal(frozen.kind, 'ok', entry.name);
    if (frozen.kind === 'ok' && frozen.run.contextRunIds) assert.ok(Object.isFrozen(frozen.run.contextRunIds), entry.name);
  }
  for (const entry of fixture.runs.invalid) assert.equal(validateConversationRun(structuredClone(entry.run)), false, entry.name);
});

test('creating a local run requires context ids, and a Claude Code run refuses them', () => {
  const args = { runId: '71abcdef-0000-4000-8abc-000000000905', sessionId: '52abcdef-0000-4000-8abc-000000000901',
    userMessageId: '72abcdef-0000-4000-8abc-000000000905', assistantMessageId: '73abcdef-0000-4000-8abc-000000000905',
    input: 'Invented question.', createdAt: '2026-10-15T07:00:00.000Z' };
  const local = fixture.context.localParticipant as { id: string; label: string; model: string; executionHost: string };
  const claude = { id: 'claude-code', label: 'Claude Code', model: 'invented-pinned-model', executionHost: 'this-mac' };
  const made = createConversationRun({ ...args, participant: local, contextRunIds: ['71abcdef-0000-4000-8abc-000000000903'] });
  assert.equal(made.kind, 'ok');
  if (made.kind === 'ok') assert.deepEqual(made.run.contextRunIds, ['71abcdef-0000-4000-8abc-000000000903']);
  assert.equal(createConversationRun({ ...args, participant: local, contextRunIds: [] }).kind, 'ok');
  assert.deepEqual(createConversationRun({ ...args, participant: local }), { kind: 'refused', reason: 'invalid-arguments' });
  assert.deepEqual(createConversationRun({ ...args, participant: claude, contextRunIds: [] }), { kind: 'refused', reason: 'invalid-arguments' });
  assert.equal(createConversationRun({ ...args, participant: claude }).kind, 'ok');
});
