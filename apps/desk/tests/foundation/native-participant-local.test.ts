import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeProofCodec, type NativeProofRequest } from '../../src/adapters/native-host-codec';
import { decodeNativeParticipantPush } from '../../src/adapters/native-participant-codec';
import { selectLocalContext } from '../../src/domain/local-participant';
import { validateState } from '../../src/domain/validation';
import { createConversationRun, freezeConversationRun, validateConversationRun, LOCAL_PARTICIPANT_ID, MAX_CONTEXT_RUNS } from '../../src/domain/conversation-runs';

// Revision 4 (contract section 20): invented local-model vectors, page side only.
type Wire = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-participant-local-v1.json', import.meta.url), 'utf8')) as {
  context: { localParticipant: Wire };
  cases: { name: string; request: Wire; reply: Wire; seed?: Wire; pushed?: Wire[]; afterRuns?: Wire[]; ollama?: Wire[] }[];
  records: Record<string, Wire>;
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

const pageCases = fixture.cases.filter(entry => entry.seed === undefined);
const hostCases = fixture.cases.filter(entry => entry.seed !== undefined);

test('every local-route fixture prepares and decodes to its exact result', () => {
  assert.equal(pageCases.length, 8);
  assert.equal(hostCases.length, 26);
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

// Step 3 PR 4c: the seeded host cases. The Swift harness replays each one
// against a fake Ollama; here the page checks what it would see of them.
const byName = new Map(fixture.cases.map(entry => [entry.name, entry]));
const chainOf = (entry: (typeof fixture.cases)[number]) => {
  const chain = [entry];
  while (chain[0]!.seed?.afterCase) chain.unshift(byName.get(chain[0]!.seed.afterCase)!);
  return chain;
};
const aliasOf = (runId: string) => `open-convo-run-${runId.replaceAll('-', '')}:pin`;
const join = (chunks: string[]) => chunks.join('');
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

test('host cases: every seeded record is one the page could have saved', () => {
  assert.deepEqual(Object.keys(fixture.records), ['local-earlier-r4', 'local-prepared-r5']);
  for (const [name, record] of Object.entries(fixture.records)) assert.equal(validateState(structuredClone(record)).valid, true, name);
});

test('host cases: every pushed participant event decodes on the page, in order, and nothing reaches a replaced document', () => {
  let events = 0;
  for (const entry of hostCases) {
    let last = 0;
    for (const detail of entry.pushed ?? []) {
      if (detail.type === 'host.connection') continue;
      const decoded = decodeNativeParticipantPush({ connectionId: detail.connectionId, documentGeneration: detail.generation }, detail);
      assert.ok(decoded, entry.name);
      assert.equal(detail.connectionId, entry.request.connectionId, entry.name);
      assert.ok(decoded.sequence > last, entry.name);
      last = decoded.sequence;
      events++;
    }
  }
  assert.equal(events, 12);
  const locked = hostCases.find(entry => entry.name.startsWith('local host: lock while'))!;
  assert.deepEqual(locked.pushed!.map(detail => detail.type), ['host.connection', 'host.connection']);
});

test('host cases: the page chooses the same earlier turns, and native binds them by count and hash, never as text', () => {
  const prepare = hostCases.find(entry => entry.name === 'local host: a preparing commit binds the earlier turn by its hash')!;
  const runs = prepare.request.payload.record.conversationRuns as Wire[];
  const run = runs.at(-1)!;
  const chosen = selectLocalContext(runs.slice(0, -1) as never, run.sessionId, join(run.inputChunks));
  assert.equal(chosen.kind, 'ok');
  if (chosen.kind !== 'ok') return;
  assert.deepEqual(chosen.contextRunIds, run.contextRunIds);
  const [entry] = prepare.afterRuns!;
  assert.deepEqual(entry!.contextRunIds, run.contextRunIds);
  assert.equal(entry!.contextBytes, chosen.contextBytes);
  assert.match(entry!.contextHash, /^[0-9a-f]{64}$/);
  for (const host of hostCases) {
    for (const saved of host.afterRuns ?? []) {
      assert.equal(saved.participant.id, 'ollama-local', host.name);
      assert.ok('contextRunIds' in saved && 'contextBytes' in saved && 'contextHash' in saved, host.name);
      for (const text of [...runs.flatMap(r => [...r.inputChunks, ...r.outputChunks])]) {
        assert.ok(!JSON.stringify(saved).includes(text), `${host.name}: the runs list holds no conversation text`);
      }
      if (saved.start) assert.equal(saved.start.cliVersion, 'ollama-local', host.name);
    }
  }
});

test('host cases: each saved ending is the last event the page received', () => {
  for (const entry of hostCases) {
    const ending = (entry.pushed ?? []).map(detail => detail.event).filter(event => event && !['started', 'text'].includes(event.type)).at(-1);
    if (!ending || !entry.afterRuns) continue;
    const saved = entry.afterRuns.find(run => run.runId === ending.runId)!;
    assert.deepEqual(saved.terminal, { type: ending.type, sequence: ending.sequence, at: ending.at, reason: ending.reason ?? null }, entry.name);
    assert.equal(saved.groupCleared, true, entry.name);
  }
});

test('host cases: what reached Ollama. A chat only after an accepted start, to the run alias, with the earlier turns then the new message', () => {
  let chats = 0;
  for (const entry of hostCases) {
    const calls = entry.ollama!;
    for (const call of calls) assert.ok(['GET /api/tags', 'POST /api/copy', 'DELETE /api/delete', 'POST /api/chat'].includes(`${call.method} ${call.path}`), entry.name);
    const sent = calls.filter(call => call.path === '/api/chat');
    const started = entry.request.operation === 'participant.start' && entry.reply.outcome === 'ok';
    if (!started || sent.length === 0) {
      assert.equal(sent.length, 0, entry.name);
      continue;
    }
    // A chat goes out only for a start the case itself accepted, after its
    // copy and a fresh catalog read; the replayed start sends nothing.
    assert.equal(sent.length, 1, entry.name);
    const at = calls.indexOf(sent[0]!);
    assert.deepEqual(calls.slice(at - 2, at).map(call => `${call.method} ${call.path}`), ['POST /api/copy', 'GET /api/tags'], entry.name);
    const payload = entry.request.payload;
    const prepare = chainOf(entry).find(step => step.request.operation === 'workspace.commitProof' && step.request.payload.participantRun)!;
    const record = prepare.request.payload.record.conversationRuns as Wire[];
    const run = record.find(r => r.runId === payload.runId)!;
    const turns = (run.contextRunIds as string[]).flatMap(id => {
      const earlier = record.find(r => r.runId === id)!;
      return [{ role: 'user', content: join(earlier.inputChunks) }, { role: 'assistant', content: join(earlier.outputChunks) }];
    });
    assert.deepEqual(sent[0]!.body, { model: aliasOf(payload.runId), stream: true, think: false,
      messages: [...turns, { role: 'user', content: join(payload.inputChunks) }] }, entry.name);
    chats++;
  }
  assert.ok(chats >= 7);
  // Replays and refusals send no chat at all.
  for (const name of ['local host: the same start again replays ok and sends nothing',
    'local host: the cut-off run is never sent again: a new start for it is duplicate-run']) {
    assert.ok(!byName.get(name)!.ollama!.some(call => call.path === '/api/chat'), name);
  }
});

test('host cases: a reply ends reply-too-long where context, input and output reach 262,144 bytes, in 16,384-byte events', () => {
  const status = hostCases.find(entry => entry.name === 'local host: status after reply-too-long names the ending')!;
  const prepare = hostCases.find(entry => entry.name === 'local host: a preparing commit binds the earlier turn by its hash')!;
  const [saved] = prepare.afterRuns!;
  const budget = 262_144 - saved!.contextBytes - saved!.inputBytes;
  const sequence = 1 + Math.ceil(budget / 16_384) + 1;
  assert.equal(status.reply.lastSequence, sequence);
  assert.deepEqual([status.reply.terminal.type, status.reply.terminal.reason, status.reply.terminal.sequence], ['failed', 'reply-too-long', sequence]);
  assert.equal(saved!.inputBytes, bytes(join(prepare.request.payload.record.conversationRuns.at(-1).inputChunks)));
});
