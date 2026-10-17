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
  canRetryLocalRun, DEFAULT_LOCAL_MODEL, defaultLocalChoice, localChoiceProblem, noLocalChoiceMessage, localRunStarted, ollamaChoiceShortName, ollamaChoiceTitle, ollamaResidency, localRouteMessage, localRunOutcome, localStartRefusalMessage,
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
    // Owner decision, October 16: the Claude entry is on the wire but not in the picker.
    assert.deepEqual(choices.map((choice) => choice.identity.id), ['ollama-local', 'ollama-local']);
    const [cloud, local] = choices;
    assert.equal(local.available, true);
    assert.equal(local.destination, 'Stays on this Mac');
    assert.equal(cloud.available, false);
    assert.match(cloud.unavailableReason!, /Ollama’s servers, not on this Mac/);
    assert.equal(runtime.localRouteMessage, undefined);
    reply = down('ollama-not-running');
    await h.connection.refreshAvailability();
    assert.equal(runtime.participantChoices!.length, 0, 'a down route lists no models, and no Claude entry in their place');
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
  assert.equal(localStartRefusalMessage('participant-busy', true, inventedLocal), undefined);
});

test('every local refusal message matches its retryability: only retryable ones point to Start prepared message', async () => {
  // Every refusal the port can give for a local start, from the real port.
  const seen: { reason: string; retryable: boolean }[] = [];
  const replies = [ready(localEntry('invented-model:7b', digestB)), ready(), ready(localEntry('invented-model:7b', digestA, false)),
    down('ollama-not-running'), { outcome: 'refused', reason: 'store-unreadable' }];
  for (const reply of replies) {
    const h = setup(() => reply);
    try {
      const result = await h.connection.portFor(inventedLocal).start(input);
      assert.equal(result.kind, 'not-started');
      if (result.kind === 'not-started') seen.push({ reason: result.reason!, retryable: result.retryable! });
      assert.equal(h.starts().length, 0);
    } finally { h.connection.dispose(); }
  }
  const h = setup(() => ready(localEntry('invented-model:7b')));
  try {
    const result = await h.connection.portFor(inventedLocal).start({ ...input, inputChunks: ['a'.repeat(MAX_LOCAL_CONTEXT_BYTES + 1)] });
    if (result.kind === 'not-started') seen.push({ reason: result.reason!, retryable: result.retryable! });
  } finally { h.connection.dispose(); }
  assert.deepEqual(seen, [
    { reason: 'participant-changed', retryable: false }, { reason: 'participant-changed', retryable: false },
    { reason: 'participant-unavailable', retryable: false }, { reason: 'participant-unavailable', retryable: true },
    { reason: 'participant-unavailable', retryable: true }, { reason: 'text-too-large', retryable: false },
  ]);
  // The full table, both flags for every local reason, including ones native sends (run-mismatch).
  for (const reason of ['run-mismatch', 'participant-changed', 'participant-unavailable', 'text-too-large']) {
    for (const retryable of [true, false]) {
      const message = localStartRefusalMessage(reason, retryable, inventedLocal)!;
      assert.match(message, /nothing was sent/, `${reason} ${retryable}`);
      assert.equal(/Start prepared message/.test(message), retryable, `${reason} ${retryable}: ${message}`);
      assert.doesNotMatch(message, /stays on this Mac/);
    }
  }
  // The model-not-local case: plain recovery, no Start control, no residency claim.
  assert.equal(localStartRefusalMessage('participant-unavailable', false, inventedLocal),
    'invented-model:7b now runs off this Mac, so it can’t be used and nothing was sent. Pick a local model, then close this message, then use Retry.');
});

test('a closure’s terminal above sequence 1 proves a start even when the gap hid started itself', () => {
  const at = '2026-10-16T12:05:00.000Z';
  const base = { ...run('Q.', '', 'prepared'), lastSequence: 0 };
  const recovered = (type: 'completed' | 'stopped' | 'failed', sequence: number, reason: 'event-refused' | 'replay-lost'): ConversationRun => ({
    ...base, closure: reason === 'replay-lost'
      ? { kind: 'interrupted', reason, at, terminalEvent: { runId: base.runId, sessionId: base.sessionId, sequence, at, type } as never,
        lost: { fromSequence: 1, throughSequence: sequence - 1, reason: 'restarted' } }
      : { kind: 'interrupted', reason, at, terminalEvent: { runId: base.runId, sessionId: base.sessionId, sequence, at, type } as never } });
  assert.equal(localRunStarted(recovered('completed', 5, 'replay-lost')), true);
  assert.equal(localRunStarted(recovered('failed', 3, 'replay-lost')), true);
  assert.equal(localRunStarted(recovered('stopped', 2, 'event-refused')), true);
  assert.equal(localRunStarted(recovered('stopped', 1, 'event-refused')), false);
  assert.equal(localRunOutcome(recovered('stopped', 1, 'event-refused')), 'Stopped before any reply started.');
  assert.match(localRunOutcome(recovered('completed', 5, 'replay-lost'))!, /^Reply finished/);
  // Saved text and a lost range after sequence 1 are evidence too.
  assert.equal(localRunStarted({ ...base, phase: 'unknown', outputChunks: ['Partial'], lastSequence: 0 }), true);
  assert.equal(localRunStarted({ ...run('Q.', '', 'running'), lastSequence: 1, closure: { kind: 'interrupted', reason: 'replay-lost', at,
    terminalEvent: { runId: base.runId, sessionId: base.sessionId, sequence: 4, at, type: 'failed' } as never,
    lost: { fromSequence: 2, throughSequence: 3, reason: 'restarted' } } }), true);
});

test('a failed availability read drops the local catalog, so nothing stays "Local" on old evidence; a later read restores it', async () => {
  let reply: Reply | 'malformed' = ready(localEntry('invented-model:7b'));
  const h = setup(() => reply === 'malformed' ? { outcome: 'ok', participants: 'invented-garbage' } : reply);
  let active = true;
  const lifecycle: RuntimeLifecycle = { isActive: () => active, subscribeInvalidation: () => () => {}, revoke: () => { active = false; } };
  const workspace: WorkspaceRepository = {
    loadLatest: async () => ({ kind: 'unavailable', error: 'Invented.' }), save: async () => ({ kind: 'unavailable', error: 'Invented.' }),
    subscribe: () => () => {},
  };
  const runtime = createNativeProofRuntime(workspace, lifecycle, { nativeParticipants: h.connection });
  try {
    await h.connection.refreshAvailability();
    assert.equal(ollamaChoiceTitle(inventedLocal, runtime.localCatalog), 'Local · invented-model:7b · stays on this Mac');
    for (const failure of ['malformed', { outcome: 'refused', reason: 'store-unreadable' }] as const) {
      reply = failure;
      await h.connection.refreshAvailability();
      assert.notEqual(h.connection.snapshot.error, null);
      assert.deepEqual(h.connection.snapshot.local, []);
      assert.equal(h.connection.snapshot.route, null);
      assert.equal(ollamaResidency(inventedLocal, runtime.localCatalog), 'unknown');
      assert.equal(ollamaChoiceTitle(inventedLocal, runtime.localCatalog), 'Ollama · invented-model:7b · not available right now');
      assert.equal(runtime.participantChoices!.some((choice) => choice.destination === 'Stays on this Mac'), false);
      assert.equal(runtime.participantChoices!.some((choice) => choice.identity.id === 'claude-code'), false,
        'no Claude entry in the picker, even while a read is failing');
      assert.equal(h.connection.portFor(inventedLocal).canStart?.(), false);
      reply = ready(localEntry('invented-model:7b'));
      await h.connection.refreshAvailability();
      assert.equal(ollamaChoiceTitle(inventedLocal, runtime.localCatalog), 'Local · invented-model:7b · stays on this Mac');
    }
  } finally { runtime.revoke(); h.connection.dispose(); }
});

test('a local reply counts as started only after the Mac reported started', () => {
  const stoppedBefore: ConversationRun = { ...run('Q.', '', 'stopped'), lastSequence: 1, reason: 'local-stop' };
  const failedBefore: ConversationRun = { ...run('Q.', '', 'failed'), lastSequence: 1, reason: 'process-error' };
  const runningNow: ConversationRun = { ...run('Q.', '', 'running'), lastSequence: 1 };
  const stoppedAfter: ConversationRun = { ...run('Q.', '', 'stopped'), lastSequence: 2, reason: 'local-stop' };
  assert.deepEqual([stoppedBefore, failedBefore, runningNow, stoppedAfter, run('Q.', 'A.')].map(localRunStarted), [false, false, true, true, true]);
  assert.equal(localRunOutcome(stoppedBefore), 'Stopped before any reply started.');
  assert.match(localRunOutcome(failedBefore)!, /^No reply started/);
  assert.equal(localRunOutcome(stoppedAfter), 'Stopped. The reply so far is kept.');
});

// Step 3 PR 4b: the owner's default model and the hidden Claude entry (decisions, October 16).
function nativeRuntime(reply: () => Reply) {
  const h = setup(reply);
  let active = true;
  const lifecycle: RuntimeLifecycle = { isActive: () => active, subscribeInvalidation: () => () => {}, revoke: () => { active = false; } };
  const workspace: WorkspaceRepository = {
    loadLatest: async () => ({ kind: 'unavailable', error: 'Invented.' }), save: async () => ({ kind: 'unavailable', error: 'Invented.' }),
    subscribe: () => () => {},
  };
  const runtime = createNativeProofRuntime(workspace, lifecycle, { nativeParticipants: h.connection });
  return { h, runtime, done: () => { runtime.revoke(); h.connection.dispose(); } };
}

test('the default model is qwen3:8b, chosen only when the catalog lists it as local and usable', async () => {
  assert.equal(DEFAULT_LOCAL_MODEL, 'qwen3:8b');
  let reply = ready(localEntry('invented-model:7b'), localEntry('qwen3:8b'));
  const { runtime, h, done } = nativeRuntime(() => reply);
  try {
    assert.equal(defaultLocalChoice(runtime.participantChoices, runtime.localCatalog), undefined, 'nothing before a check');
    await h.connection.refreshAvailability();
    assert.deepEqual(defaultLocalChoice(runtime.participantChoices, runtime.localCatalog),
      { id: 'ollama-local', label: 'qwen3:8b', model: `qwen3:8b@${digestA}`, executionHost: 'this-mac' });
    // Listed but not local: never chosen, and nothing else in its place.
    reply = ready(localEntry('invented-model:7b'), localEntry('qwen3:8b', digestA, false));
    await h.connection.refreshAvailability();
    assert.equal(defaultLocalChoice(runtime.participantChoices, runtime.localCatalog), undefined);
    // Not installed: the plain hint names the default.
    reply = ready(localEntry('invented-model:7b'));
    await h.connection.refreshAvailability();
    assert.equal(defaultLocalChoice(runtime.participantChoices, runtime.localCatalog), undefined);
    assert.match(noLocalChoiceMessage(runtime.localCatalog!), /qwen3:8b isn’t installed in Ollama on this Mac\. Pick a local model/);
    // Ollama down: no default, and the route's own reason, not the model's.
    reply = down('ollama-not-running');
    await h.connection.refreshAvailability();
    assert.equal(defaultLocalChoice(runtime.participantChoices, runtime.localCatalog), undefined);
    assert.equal(noLocalChoiceMessage(runtime.localCatalog!), `No model chosen yet. ${localRouteMessage('ollama-not-running')}`);
  } finally { done(); }
});

test('a host without a local route (contract revision 3) still lists its Claude entry', async () => {
  const { runtime, h, done } = nativeRuntime(() => ({ outcome: 'ok', participants: [{ ...claude, available: false, reason: 'overflow-unverified' }] }));
  try {
    await h.connection.refreshAvailability();
    assert.equal(h.connection.snapshot.offersLocal, false);
    assert.deepEqual(runtime.participantChoices!.map((choice) => choice.identity.id), ['claude-code']);
  } finally { done(); }
});

test('every way the default can be missing gives its own reason and a next step (Codex round 1 on #61)', () => {
  const view = (route: { state: 'ready' | 'unavailable'; reason: string | null } | null, ...entries: Reply[]) =>
    ({ route, entries: entries as never });
  const ok = { state: 'ready' as const, reason: null };
  const other = localEntry('invented-model:7b');
  const cases: [ReturnType<typeof view>, RegExp][] = [
    [view({ state: 'unavailable', reason: 'ollama-not-running' }), /Ollama is not running on this Mac\. Open Ollama/],
    [view({ state: 'unavailable', reason: 'catalog-unreadable' }), /list of models could not be read\. Restart Ollama/],
    [view({ state: 'unavailable', reason: 'host-not-loopback' }), /did not lead back to this Mac/],
    [view(null), /Local models could not be checked\. Your draft is kept; check again/],
    [view(ok, other, localEntry('qwen3:8b', digestA, false)), /qwen3:8b isn’t on this Mac right now \(it runs on Ollama’s servers\)\. Pick another local model/],
    [view(ok, localEntry('qwen3:8b', digestA, false)), /runs on Ollama’s servers\)\. No other local model is installed either\. Install one in Ollama/],
    [view(ok, other, { ...localEntry('qwen3:8b'), available: false, reason: 'invented-other-reason' }), /qwen3:8b isn’t available on this Mac right now\. Pick another local model/],
    [view(ok, other), /qwen3:8b isn’t installed in Ollama on this Mac\. Pick a local model in the model picker/],
    [view(ok), /No local models are installed in Ollama on this Mac\. Install qwen3:8b \(or another model\) in Ollama/],
    [view(ok, other, localEntry('qwen3:8b')), /Choose a local model in the model picker before sending/],
  ];
  for (const [catalog, expected] of cases) {
    const message = noLocalChoiceMessage(catalog);
    assert.match(message, expected, JSON.stringify(catalog.route));
    assert.match(message, /^No model chosen yet\. /);
  }
  assert.equal(new Set(cases.map(([catalog]) => noLocalChoiceMessage(catalog))).size, cases.length, 'each case has its own words');
});
