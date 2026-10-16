import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NativeProofCodec, NATIVE_PROOF_LIMITS, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';
import { localParticipantInputWithinLimit, NativeParticipantConnection } from '../../src/adapters/native-participant-port';
import type { ParticipantStartInput } from '../../src/adapters/participant-runtime';
import { createNativeProofRuntime, type RuntimeLifecycle } from '../../src/app/runtime';
import type { WorkspaceRepository } from '../../src/adapters/workspace-repository';
import type { ConversationRun } from '../../src/domain/conversation-run-types';
import { createConversationRun } from '../../src/domain/conversation-runs';
import {
  canRetryLocalRun, localChoiceProblem, ollamaChoiceShortName, ollamaChoiceTitle, ollamaResidency, localRouteMessage, localRunOutcome, localStartRefusalMessage,
  MAX_LOCAL_CONTEXT_BYTES, selectLocalContext,
} from '../../src/domain/local-participant';

// Step 3 PR 4a: the Desk side of a local model. Invented models, digests and text only.
const context = { connectionId: 'invented-local-connection', documentGeneration: 2 };
const claude = { id: 'claude-code', label: 'Invented Claude participant', model: 'invented-model', executionHost: 'this-mac' };
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const localEntry = (name: string, digest = digestA, available = true) => ({ id: 'ollama-local', label: name, model: `${name}@${digest}`,
  executionHost: 'this-mac', available, reason: available ? null : 'model-not-local' });
const inventedLocal = { id: 'ollama-local', label: 'invented-model:7b', model: `invented-model:7b@${digestA}`, executionHost: 'this-mac' };
const target = { runId: '22000000-0000-4000-8000-000000000001', sessionId: '22000000-0000-4000-8000-000000000002' };
const input: ParticipantStartInput = { ...target, userMessageId: '22000000-0000-4000-8000-000000000003',
  assistantMessageId: '22000000-0000-4000-8000-000000000004', participant: inventedLocal, inputChunks: ['Invented question.'] };
const requestId = (n: number) => `23000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type WireRequest = { v: number; requestId: string; connectionId: string; generation: number; operation: string; payload: Record<string, unknown> };
type Reply = Record<string, unknown>;
const ready = (...local: Reply[]): Reply => ({ outcome: 'ok', participants: [{ ...claude, available: false, reason: 'overflow-unverified' }, ...local],
  routes: [{ route: 'ollama-local', state: 'ready', reason: null }] });
const down = (reason: string): Reply => ({ outcome: 'ok', participants: [{ ...claude, available: false, reason: 'overflow-unverified' }],
  routes: [{ route: 'ollama-local', state: 'unavailable', reason }] });

function setup(availability: () => Reply) {
  const requests: WireRequest[] = [];
  let deliver = (_wire: string) => {};
  let seq = 0;
  const transport: NativeHostTransport = {
    listen(reply) { deliver = reply; return () => {}; },
    async send(wire) {
      const request = JSON.parse(wire) as WireRequest;
      requests.push(request);
      const response = request.operation === 'participant.availability' ? availability()
        : request.operation === 'participant.start' ? { outcome: 'ok', runId: target.runId } : { outcome: 'refused', reason: 'unknown-run' };
      const { payload: _payload, ...base } = request;
      deliver(JSON.stringify({ ...base, ...response }));
    },
  };
  const codec = new NativeProofCodec(context, 128);
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec,
    { ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 128, timeoutMs: 1000 });
  const connection = new NativeParticipantConnection({ client, context, workspaceHandle: 'invented-workspace', events: new EventTarget(),
    requestId: () => requestId(++seq) });
  return { connection, requests, starts: () => requests.filter((r) => r.operation === 'participant.start') };
}

test('a local model starts only with its exact name and digest in a ready route, never the Claude entry instead', async (t) => {
  const h = setup(() => ready(localEntry('invented-model:7b')));
  t.after(() => h.connection.dispose());
  const port = h.connection.portFor(inventedLocal);
  assert.equal(port.canStart?.(), false, 'nothing is known before a check');
  await h.connection.refreshAvailability();
  assert.equal(port.canStart?.(), true);
  assert.deepEqual(await port.start(input), { kind: 'accepted' });
  assert.deepEqual(h.starts()[0].payload.participant, inventedLocal);
  assert.equal(h.connection.snapshot.local.length, 1);
  assert.deepEqual(h.connection.snapshot.route, { route: 'ollama-local', state: 'ready', reason: null });
});

test('a moved tag, a missing model, a cloud model or a down route sends nothing', async () => {
  const cases: [Reply, string, boolean][] = [
    [ready(localEntry('invented-model:7b', digestB)), 'participant-changed', false],
    // Section 20.4: a ready catalog without this exact name and digest is a change, whatever else it lists.
    [ready(localEntry('invented-other:3b')), 'participant-changed', false],
    [ready(), 'participant-changed', false],
    [ready(localEntry('invented-model:7b', digestA, false)), 'participant-unavailable', false],
    [down('ollama-not-running'), 'participant-unavailable', true],
    [down('host-not-loopback'), 'participant-unavailable', true],
  ];
  for (const [reply, reason, retryable] of cases) {
    const h = setup(() => reply);
    try {
      const port = h.connection.portFor(inventedLocal);
      assert.deepEqual(await port.start(input), { kind: 'not-started', reason, retryable }, JSON.stringify(reply));
      assert.equal(h.starts().length, 0);
      assert.equal(port.canStart?.(), false);
    } finally { h.connection.dispose(); }
  }
});

test('a local run has the one 262,144-byte input limit, not the Claude first-trial limit', async (t) => {
  assert.equal(localParticipantInputWithinLimit(['é'.repeat(4096)]), true);
  assert.equal(localParticipantInputWithinLimit(['a'.repeat(MAX_LOCAL_CONTEXT_BYTES)]), true);
  assert.equal(localParticipantInputWithinLimit(['a'.repeat(MAX_LOCAL_CONTEXT_BYTES), 'a']), false);
  const h = setup(() => ready(localEntry('invented-model:7b')));
  t.after(() => h.connection.dispose());
  assert.deepEqual(await h.connection.portFor(inventedLocal).start({ ...input, inputChunks: ['é'.repeat(4096)] }), { kind: 'accepted' });
});

test('the runtime lists each local model as its own choice that stays on this Mac, and names a down route', async () => {
  let reply = ready(localEntry('invented-cloud:cloud', digestB, false), localEntry('invented-model:7b'));
  // Code-point order: "invented-cloud" sorts before "invented-model".
  const h = setup(() => reply);
  let active = true;
  const lifecycle: RuntimeLifecycle = { isActive: () => active, subscribeInvalidation: () => () => {}, revoke: () => { active = false; } };
  const workspace: WorkspaceRepository = {
    loadLatest: async () => ({ kind: 'unavailable', error: 'Invented.' }), save: async () => ({ kind: 'unavailable', error: 'Invented.' }),
    subscribe: () => () => {},
  };
  const runtime = createNativeProofRuntime(workspace, lifecycle, { nativeParticipants: h.connection });
  try {
    await h.connection.refreshAvailability();
    const choices = runtime.participantChoices!;
    assert.deepEqual(choices.map((choice) => choice.identity.id), ['claude-code', 'ollama-local', 'ollama-local']);
    const [, cloud, local] = choices;
    assert.equal(local.available, true);
    assert.equal(local.destination, 'Stays on this Mac');
    assert.equal(cloud.available, false);
    assert.match(cloud.unavailableReason!, /Ollama’s servers, not on this Mac/);
    assert.equal(runtime.localRouteMessage, undefined);
    reply = down('ollama-not-running');
    await h.connection.refreshAvailability();
    assert.equal(runtime.participantChoices!.length, 1);
    assert.equal(runtime.localRouteMessage, localRouteMessage('ollama-not-running'));
    assert.match(runtime.localRouteMessage!, /Ollama is not running on this Mac/);
  } finally { runtime.revoke(); h.connection.dispose(); }
});

test('every route reason has its own plain message', () => {
  const messages = ['ollama-not-running', 'catalog-unreadable', 'catalog-too-large', 'host-not-loopback'].map(localRouteMessage);
  assert.equal(new Set(messages).size, 4);
  assert.match(messages[2], /more than 256 models/);
  assert.match(messages[3], /lead back to this Mac/);
});

test('the page derives "missing" and "changed" for a saved local choice', () => {
  const route = { state: 'ready' as const, reason: null };
  assert.equal(localChoiceProblem(inventedLocal, { route, entries: [localEntry('invented-model:7b')] }), null);
  assert.match(localChoiceProblem(inventedLocal, { route, entries: [localEntry('invented-model:7b', digestB)] })!, /changed in Ollama/);
  assert.match(localChoiceProblem(inventedLocal, { route, entries: [] })!, /no longer installed/);
  assert.match(localChoiceProblem(inventedLocal, { route: { state: 'unavailable', reason: 'catalog-unreadable' }, entries: [] })!, /could not be read/);
  assert.match(localChoiceProblem(inventedLocal, { route: null, entries: [] })!, /does not offer local models/);
});

test('only the current catalog’s exact local entry is called "stays on this Mac"', () => {
  const route = { state: 'ready' as const, reason: null };
  const present = { route, entries: [localEntry('invented-model:7b')] };
  assert.equal(ollamaResidency(inventedLocal, present), 'local');
  assert.equal(ollamaChoiceTitle(inventedLocal, present), 'Local · invented-model:7b · stays on this Mac');
  assert.equal(ollamaChoiceShortName(inventedLocal, present), 'Local · invented-model:7b');

  // A saved local pin while the route is down, or with no catalog at all: neutral.
  for (const catalog of [{ route: { state: 'unavailable' as const, reason: 'ollama-not-running' }, entries: [] }, { route: null, entries: [] }, undefined]) {
    assert.equal(ollamaResidency(inventedLocal, catalog), 'unknown');
    assert.equal(ollamaChoiceTitle(inventedLocal, catalog), 'Ollama · invented-model:7b · not available right now');
    assert.equal(ollamaChoiceShortName(inventedLocal, catalog), 'Ollama · invented-model:7b');
  }
  // Same name, other digest; or removed: neutral, never local.
  assert.equal(ollamaChoiceTitle(inventedLocal, { route, entries: [localEntry('invented-model:7b', digestB)] }), 'Ollama · invented-model:7b · changed since you chose it');
  assert.equal(ollamaChoiceTitle(inventedLocal, { route, entries: [] }), 'Ollama · invented-model:7b · no longer installed');

  // A remote model whose name has no ":cloud": cloud while the catalog lists it so...
  const remoteEntry = localEntry('invented-remote:20b', digestB, false);
  const { available: _a, reason: _r, ...remotePin } = remoteEntry;
  assert.equal(ollamaChoiceTitle(remotePin, { route, entries: [remoteEntry] }), 'Cloud · invented-remote:20b · not on this Mac (can’t be used)');
  assert.equal(ollamaChoiceShortName(remotePin, { route, entries: [remoteEntry] }), 'Cloud · invented-remote:20b');
  // ...and neutral, never local, once it disappears or the route goes down.
  for (const catalog of [{ route, entries: [] }, { route, entries: [localEntry('invented-model:7b')] },
    { route: { state: 'unavailable' as const, reason: 'catalog-unreadable' }, entries: [] }]) {
    assert.equal(ollamaResidency(remotePin, catalog), 'unknown');
    assert.match(ollamaChoiceTitle(remotePin, catalog), /^Ollama · invented-remote:20b · /);
    assert.doesNotMatch(ollamaChoiceTitle(remotePin, catalog), /stays on this Mac|^Local/);
  }
  // A ":cloud" name is cloud whatever the catalog says.
  const named = { ...inventedLocal, label: 'invented-thing:cloud', model: `invented-thing:cloud@${digestB}` };
  assert.equal(ollamaResidency(named, undefined), 'cloud');
  assert.equal(ollamaResidency(named, { route, entries: [localEntry('invented-thing:cloud', digestB, true)] }), 'cloud');
});

let ids = 0;
const id = () => `24000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
function run(text: string, reply: string, phase: ConversationRun['phase'] = 'completed', sessionId = target.sessionId): ConversationRun {
  const created = createConversationRun({ runId: id(), sessionId, userMessageId: id(), assistantMessageId: id(), participant: inventedLocal,
    input: text, createdAt: '2026-10-16T12:00:00.000Z', contextRunIds: [] });
  assert.equal(created.kind, 'ok');
  if (created.kind !== 'ok') throw new Error();
  return { ...created.run, outputChunks: reply ? [reply] : [], phase, lastSequence: phase === 'completed' ? 3 : 2 };
}

test('context is the session’s earlier completed turns, oldest first, leaving out the oldest whole turns to fit', () => {
  const first = run('Invented first.', 'Invented first reply.');
  const failed = run('Invented failed.', 'Cut', 'failed');
  const other = run('Invented elsewhere.', 'Elsewhere reply.', 'completed', '22000000-0000-4000-8000-000000000099');
  const second = run('Invented second.', 'Invented second reply.');
  const result = selectLocalContext([first, failed, other, second], target.sessionId, 'Invented new message.');
  assert.deepEqual(result, { kind: 'ok', contextRunIds: [first.runId, second.runId],
    contextBytes: 'Invented first.Invented first reply.Invented second.Invented second reply.'.length });
  // A big middle turn: everything older than it is left out whole, never cut.
  const big = run('x'.repeat(200_000), 'y'.repeat(50_000));
  const fitted = selectLocalContext([first, big, second], target.sessionId, 'z'.repeat(20_000));
  assert.deepEqual(fitted.kind === 'ok' && fitted.contextRunIds, [second.runId]);
  assert.deepEqual(selectLocalContext([first], target.sessionId, 'é'.repeat(MAX_LOCAL_CONTEXT_BYTES / 2)), { kind: 'ok', contextRunIds: [], contextBytes: 0 });
  assert.deepEqual(selectLocalContext([], target.sessionId, 'a'.repeat(MAX_LOCAL_CONTEXT_BYTES + 1)), { kind: 'too-large' });
});

test('context holds at most 256 earlier turns', () => {
  const many = Array.from({ length: 300 }, (_, index) => run(`Invented ${index}.`, 'Ok.'));
  const result = selectLocalContext(many, target.sessionId, 'New.');
  assert.equal(result.kind === 'ok' && result.contextRunIds.length, 256);
  assert.equal(result.kind === 'ok' && result.contextRunIds[0], many[44].runId);
});

test('every ending of a local reply has a plain message, and Retry is offered only on a cut-off or failed reply', () => {
  const at = '2026-10-16T12:01:00.000Z';
  const completed = run('Q.', 'A.');
  const stopped: ConversationRun = { ...run('Q.', 'Partial', 'stopped'), reason: 'local-stop' };
  const tooLong: ConversationRun = { ...run('Q.', 'Partial', 'failed'), reason: 'reply-too-long' };
  const timeout: ConversationRun = { ...run('Q.', 'Partial', 'failed'), reason: 'timeout' };
  const broken: ConversationRun = { ...run('Q.', 'Partial', 'failed'), reason: 'process-error' };
  const crashed: ConversationRun = { ...run('Q.', 'Partial', 'running'), closure: { kind: 'unknown', reason: 'user-closed', at } };
  assert.match(localRunOutcome(completed)!, /complete/);
  assert.match(localRunOutcome(stopped)!, /^Stopped/);
  assert.match(localRunOutcome(tooLong)!, /length limit/);
  assert.match(localRunOutcome(timeout)!, /in time/);
  assert.match(localRunOutcome(broken)!, /broke off/);
  assert.match(localRunOutcome(crashed)!, /cut off/);
  assert.equal(localRunOutcome(run('Q.', '', 'running')), undefined);
  assert.deepEqual([completed, stopped, tooLong, timeout, broken, crashed].map(canRetryLocalRun), [false, true, true, true, true, true]);
  assert.equal(canRetryLocalRun({ ...stopped, participant: claude }), false, 'Retry is local-only in this step');
  for (const reason of ['run-mismatch', 'participant-changed', 'participant-unavailable', 'text-too-large']) {
    assert.match(localStartRefusalMessage(reason, inventedLocal)!, /nothing was sent/);
  }
  assert.equal(localStartRefusalMessage('participant-busy', inventedLocal), undefined);
});
