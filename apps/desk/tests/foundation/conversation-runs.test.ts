import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeUnreachableCleanup, appendParticipantEvent, chunkRunText, closeConversationRun, conversationRunSerializedBytes, createConversationRun,
  freezeConversationRun, isConversationRunClosed, joinRunChunks, MAX_PARTICIPANT_FIELD_BYTES,
  MAX_RUN_CHUNK_BYTES, MAX_RUN_CLOSURE_BYTES, MAX_RUN_SERIALIZED_BYTES, MAX_RUN_TEXT_BYTES, validateConversationRun, validateParticipantEvent,
  type ConversationRunResult, type CreateConversationRunArgs,
} from '../../src/domain/conversation-runs';
import type { ConversationRun, ConversationRunClosure, ParticipantEvent, ParticipantStopReason } from '../../src/domain/conversation-run-types';

const ids = {
  runId: 'aaaaaaaa-1111-4111-8111-111111111111',
  sessionId: 'BBBBBBBB-2222-1222-8222-222222222222',
  userMessageId: 'cccccccc-3333-4333-8333-333333333333',
  assistantMessageId: 'dddddddd-4444-4444-8444-444444444444',
};
const time = '2026-10-09T12:00:00.000Z';
const later = '2026-10-09T12:00:01.000Z';
function args(input = 'Invented input'): CreateConversationRunArgs {
  return { ...ids, participant: { id: 'invented-participant', label: 'Example participant', model: 'example-model', executionHost: 'invented-host' }, input, createdAt: time };
}
function accepted(result: ConversationRunResult): ConversationRun {
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Expected accepted invented record.');
  assert.equal(validateConversationRun(result.run), true);
  return result.run;
}
function prepared(input?: string): ConversationRun { return accepted(createConversationRun(args(input))); }
function event(type: 'started' | 'completed' | 'stopped' | 'failed', sequence = 1): ParticipantEvent {
  return { runId: ids.runId, sessionId: ids.sessionId, sequence, at: time, type };
}
function text(text: string, sequence = 2): ParticipantEvent {
  return { runId: ids.runId, sessionId: ids.sessionId, sequence, at: time, type: 'text', text };
}
function running(input?: string): ConversationRun { return accepted(appendParticipantEvent(prepared(input), event('started'))); }
function appendText(run: ConversationRun, literal: string): ConversationRun {
  const chunks = chunkRunText(literal);
  assert.equal(chunks.kind, 'ok');
  if (chunks.kind !== 'ok') throw Error('Invalid invented text');
  for (const chunk of chunks.chunks) run = accepted(appendParticipantEvent(run, text(chunk, run.lastSequence + 1)));
  return run;
}
function refusal(result: ConversationRunResult, reason: string) {
  assert.deepEqual(result, { kind: 'refused', reason });
}

test('creation preserves literal input, participant identity and existing UUID spelling in an independent prepared record', () => {
  const input = '  <script>example</script>\n\t café cafe\u0301 👩🏽‍💻 \u0000 ';
  const source = args(input);
  const run = accepted(createConversationRun(source));
  assert.deepEqual(joinRunChunks(run.inputChunks), { kind: 'ok', text: input });
  assert.equal(run.sessionId, ids.sessionId);
  assert.equal(run.phase, 'prepared');
  assert.equal(run.lastSequence, 0);
  assert.deepEqual(run.outputChunks, []);
  source.participant.label = 'Changed later';
  assert.equal(run.participant.label, 'Example participant');
});

test('chunks respect UTF-8 byte bounds and never split scalar values at a boundary', () => {
  const input = 'a'.repeat(MAX_RUN_CHUNK_BYTES - 1) + '😀é漢\n' + '🙂'.repeat(5000);
  const result = chunkRunText(input);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.chunks[0], 'a'.repeat(MAX_RUN_CHUNK_BYTES - 1));
  for (const chunk of result.chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= MAX_RUN_CHUNK_BYTES);
    assert.equal(Buffer.from(chunk).toString('utf8'), chunk);
  }
  assert.deepEqual(joinRunChunks(result.chunks), { kind: 'ok', text: input });
  assert.deepEqual(chunkRunText(''), { kind: 'ok', chunks: [] });
  assert.deepEqual(joinRunChunks([]), { kind: 'ok', text: '' });
});

test('unpaired surrogate input or events are refused, including halves that could be repaired only by joining', () => {
  for (const value of ['\ud800', '\udc00', 'x\ud800y', '\udc00\ud800']) {
    assert.deepEqual(chunkRunText(value), { kind: 'refused', reason: 'invalid-text' });
    refusal(createConversationRun(args(value)), 'invalid-text');
    assert.equal(validateParticipantEvent(text(value)), false);
    refusal(appendParticipantEvent(running(), text(value)), 'invalid-event');
  }
  assert.deepEqual(joinRunChunks(['\ud83d', '\ude00']), { kind: 'refused', reason: 'invalid-text' });
});

test('large literal replies are chunked across events and retained exactly through completion', () => {
  const first = 'Text é漢🙂\n'.repeat(9000);
  const second = '\n  <b>literal</b> cafe\u0301 ';
  const initial = running();
  const before = structuredClone(initial);
  const one = appendText(initial, first);
  const two = accepted(appendParticipantEvent(one, { ...text(second, one.lastSequence + 1), at: later }));
  const done = accepted(appendParticipantEvent(two, { ...event('completed', two.lastSequence + 1), at: later }));
  assert.deepEqual(joinRunChunks(done.outputChunks), { kind: 'ok', text: first + second });
  assert.ok(done.outputChunks.length > 1);
  assert.equal(done.phase, 'completed');
  assert.equal(done.updatedAt, later);
  assert.deepEqual(initial, before);
  assert.deepEqual(one.outputChunks.join(''), first);
});

test('the combined input/output limit accepts its boundary and refuses another scalar without truncation', () => {
  const initial = running('i'.repeat(1024));
  const full = appendText(initial, 'x'.repeat(MAX_RUN_TEXT_BYTES - 1024));
  const before = structuredClone(full);
  refusal(appendParticipantEvent(full, text('é', full.lastSequence + 1)), 'text-limit');
  assert.deepEqual(full, before);
  assert.equal(full.outputChunks.join('').length, MAX_RUN_TEXT_BYTES - 1024);
  refusal(createConversationRun(args('é'.repeat(MAX_RUN_TEXT_BYTES / 2 + 1))), 'text-limit');
  refusal(createConversationRun(args('a'.repeat(MAX_RUN_TEXT_BYTES + 1))), 'text-limit');
});

test('JSON escaping has a separate explicit record bound before a native workspace save', () => {
  const escaped = '\u0000'.repeat(128 * 1024);
  assert.ok(Buffer.byteLength(escaped) < MAX_RUN_TEXT_BYTES);
  refusal(createConversationRun(args(escaped)), 'run-size-limit');
  const initial = appendText(running(), '\u0000'.repeat(7 * MAX_RUN_CHUNK_BYTES));
  const before = structuredClone(initial);
  refusal(appendParticipantEvent(initial, text('\u0000'.repeat(MAX_RUN_CHUNK_BYTES), initial.lastSequence + 1)), 'run-size-limit');
  assert.deepEqual(initial, before);
  const forged = { ...initial, lastSequence: 2, outputChunks: Array.from({ length: 8 }, () => '\u0000'.repeat(MAX_RUN_CHUNK_BYTES)) };
  assert.ok(Buffer.byteLength(JSON.stringify(forged)) > MAX_RUN_SERIALIZED_BYTES);
  assert.equal(validateConversationRun(forged), false);
});

test('only exact next sequence is accepted; duplicates, older events and gaps never change a run', () => {
  const initial = accepted(appendParticipantEvent(running(), text('Saved partial')));
  const before = structuredClone(initial);
  for (const sequence of [1, 2, 4, Number.MAX_SAFE_INTEGER]) {
    refusal(appendParticipantEvent(initial, text('Changed or repeated delivery', sequence)), 'sequence-mismatch');
  }
  refusal(appendParticipantEvent(initial, event('started', 3)), 'invalid-transition');
  assert.deepEqual(initial, before);
});

test('foreign run or session identities cannot append, including a changed spelling of the captured session ID', () => {
  const initial = running();
  const before = structuredClone(initial);
  for (const change of [{ runId: ids.userMessageId }, { sessionId: ids.assistantMessageId }, { sessionId: ids.sessionId.toLowerCase() }]) {
    refusal(appendParticipantEvent(initial, { ...text('Foreign text'), ...change }), 'target-mismatch');
  }
  assert.deepEqual(initial, before);
});

test('started is required before text/completion while Stop or failure may finish a prepared run', () => {
  refusal(appendParticipantEvent(prepared(), text('Too early', 1)), 'invalid-transition');
  refusal(appendParticipantEvent(prepared(), event('completed')), 'invalid-transition');
  for (const type of ['stopped', 'failed'] as const) {
    const ended = accepted(appendParticipantEvent(prepared(), event(type)));
    assert.equal(ended.phase, type);
    assert.deepEqual(ended.outputChunks, []);
  }
});

test('empty completion is valid and all terminal states retain partial output without revival', () => {
  const empty = accepted(appendParticipantEvent(running(), event('completed', 2)));
  assert.deepEqual(empty.outputChunks, []);
  for (const type of ['completed', 'stopped', 'failed'] as const) {
    const partial = accepted(appendParticipantEvent(running(), text('Literal partial')));
    const ended = accepted(appendParticipantEvent(partial, event(type, 3)));
    const before = structuredClone(ended);
    for (const next of [text('Late', 4), event('started', 4), event('completed', 4), event('stopped', 4), event('failed', 4)]) {
      refusal(appendParticipantEvent(ended, next), 'invalid-transition');
    }
    assert.equal(ended.outputChunks.join(''), 'Literal partial');
    assert.deepEqual(ended, before);
  }
});

test('unknown records do not revive from an ordinary stream event', () => {
  const unknown: ConversationRun = { ...running(), phase: 'unknown' };
  assert.equal(validateConversationRun(unknown), true);
  refusal(appendParticipantEvent(unknown, text('Not reconciled')), 'invalid-transition');
  refusal(appendParticipantEvent(unknown, event('stopped', 2)), 'invalid-transition');
});

test('dates must be canonical valid UTC dates while sequence advances logical time across clock skew', () => {
  for (const invalid of ['2026-02-30T12:00:00.000Z', '2026-10-09T12:00:00Z', '2026-10-09T12:00:00.000+00:00', '2026-10-09', 'not-a-date']) {
    refusal(createConversationRun({ ...args(), createdAt: invalid }), 'invalid-arguments');
    assert.equal(validateParticipantEvent({ ...event('started'), at: invalid }), false);
  }
  const initial = accepted(appendParticipantEvent(prepared(), { ...event('started'), at: later }));
  const skewed = text('Older participant clock');
  const progressed = accepted(appendParticipantEvent(initial, skewed));
  assert.equal(progressed.updatedAt, later);
  assert.equal(progressed.outputChunks.join(''), 'Older participant clock');
  assert.equal(skewed.at, time, 'The source event timestamp remains evidence, not a fabricated replacement.');
  assert.equal(accepted(appendParticipantEvent(progressed, { ...event('completed', 3), at: time })).updatedAt, later);
  assert.equal(validateConversationRun({ ...initial, updatedAt: '2026-10-08T12:00:00.000Z' }), false);
});

test('new IDs are distinct canonical UUIDv4 while existing session IDs allow v1–5 without rewriting', () => {
  for (const change of [
    { runId: ids.runId.toUpperCase() }, { userMessageId: ids.sessionId }, { assistantMessageId: ids.userMessageId },
    { runId: ids.userMessageId }, { sessionId: ids.runId }, { sessionId: 'not-a-uuid' },
  ]) refusal(createConversationRun({ ...args(), ...change }), 'invalid-arguments');
  for (const version of [1, 2, 3, 4, 5]) {
    const sessionId = `BBBBBBBB-2222-${version}222-8222-222222222222`;
    assert.equal(accepted(createConversationRun({ ...args(), sessionId })).sessionId, sessionId);
  }
});

test('participant metadata is exact, nonempty, bounded Unicode and is never echoed in refusals', () => {
  for (const invalid of ['', '   ', '\ud800', 'é'.repeat(MAX_PARTICIPANT_FIELD_BYTES / 2 + 1)]) {
    const source = args();
    source.participant.model = invalid;
    refusal(createConversationRun(source), 'invalid-arguments');
  }
  const source = args();
  (source.participant as unknown as Record<string, unknown>).secret = 'invented-not-to-echo';
  refusal(createConversationRun(source), 'invalid-arguments');
});

test('saved record phases, sequence and output must agree and numeric sequence values are safe integers', () => {
  const base = prepared();
  for (const change of [
    { phase: 'prepared', lastSequence: 1 }, { phase: 'prepared', updatedAt: later },
    { phase: 'running', lastSequence: 0 }, { phase: 'running', lastSequence: 1, outputChunks: ['Impossible early output'] },
    { phase: 'completed', lastSequence: 1 }, { phase: 'completed', lastSequence: 2, outputChunks: ['Impossible output'] },
    { phase: 'stopped', lastSequence: 0 }, { phase: 'failed', lastSequence: 1, outputChunks: ['Impossible output'] },
    { phase: 'unknown', lastSequence: 0, outputChunks: ['Impossible output'] }, { phase: 'arbitrary' },
    { lastSequence: -1 }, { lastSequence: 1.5 }, { lastSequence: Number.NaN }, { lastSequence: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(validateConversationRun({ ...base, ...change }), false);
  for (const sequence of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateParticipantEvent({ ...event('started'), sequence }), false);
  }
});

test('validators reject extra keys, getters, prototypes, sparse chunks and oversized chunk items', () => {
  let accessed = 0;
  const getter = { ...prepared() };
  Object.defineProperty(getter, 'phase', { enumerable: true, get: () => { accessed++; return 'prepared'; } });
  assert.equal(validateConversationRun(getter), false);
  assert.equal(accessed, 0);
  const eventGetter = { ...event('started') };
  Object.defineProperty(eventGetter, 'type', { enumerable: true, get: () => { accessed++; return 'started'; } });
  assert.equal(validateParticipantEvent(eventGetter), false);
  assert.equal(accessed, 0);
  for (const invalid of [
    { ...prepared(), extra: true }, { ...prepared(), [Symbol('hidden')]: 'no' },
    Object.assign(Object.create({ inherited: true }), prepared()),
    { ...prepared(), inputChunks: Array(1) }, { ...prepared(), inputChunks: [''] },
    { ...prepared(), inputChunks: ['a'.repeat(MAX_RUN_CHUNK_BYTES + 1)] },
    { ...prepared(), inputChunks: Object.assign(['abc'], { extra: true }) },
  ]) assert.equal(validateConversationRun(invalid), false);
  assert.equal(validateParticipantEvent({ ...event('started'), text: 'Unexpected' }), false);
  assert.equal(validateParticipantEvent({ ...text('abc'), extra: true }), false);
  assert.equal(validateParticipantEvent({ ...event('started'), type: 'unknown' }), false);
});

test('accepted records are immutable and external mutable records never gain cached validation authority', () => {
  const before = running();
  Object.freeze(before.participant);
  Object.freeze(before.inputChunks);
  Object.freeze(before.outputChunks);
  Object.freeze(before);
  const next = accepted(appendParticipantEvent(before, text('New output')));
  assert.throws(() => { next.inputChunks[0] = 'Changed output object input'; }, TypeError);
  assert.throws(() => { next.outputChunks[0] = 'Changed output object output'; }, TypeError);
  assert.throws(() => { next.participant.label = 'Changed output object participant'; }, TypeError);
  assert.equal(before.inputChunks[0], 'Invented input');
  assert.deepEqual(before.outputChunks, []);
  assert.equal(before.participant.label, 'Example participant');
  const mutable = structuredClone(before);
  assert.equal(validateConversationRun(mutable), true);
  const captured = accepted(freezeConversationRun(mutable));
  mutable.participant.model = 'Changed afterwards';
  mutable.inputChunks[0] = 'Different input';
  assert.equal(captured.participant.model, 'example-model');
  assert.equal(captured.inputChunks[0], 'Invented input');
  mutable.lastSequence = 0;
  assert.equal(validateConversationRun(mutable), false);
  assert.equal(conversationRunSerializedBytes(mutable), null);
  refusal(appendParticipantEvent(mutable, text('Invalid earlier record')), 'invalid-run');
});

test('individual text events are bounded at exactly 16 KiB of scalar UTF-8', () => {
  for (const literal of ['a'.repeat(MAX_RUN_CHUNK_BYTES), '🙂'.repeat(MAX_RUN_CHUNK_BYTES / 4)]) {
    assert.equal(validateParticipantEvent(text(literal)), true);
    assert.equal(accepted(appendParticipantEvent(running(), text(literal))).outputChunks.join(''), literal);
    assert.equal(validateParticipantEvent(text(literal + 'a')), false);
    refusal(appendParticipantEvent(running(), text(literal + 'a')), 'invalid-event');
  }
  assert.equal(validateParticipantEvent(text('a'.repeat(200 * 1024))), false);
});

test('stopped and failed evidence preserve only the agreed native reason enum', () => {
  const reasons: ParticipantStopReason[] = ['local-stop', 'stop-incomplete', 'reply-too-long', 'paid-overflow', 'timeout', 'process-error'];
  for (const type of ['stopped', 'failed'] as const) {
    for (const reason of reasons) {
      const terminal = { ...event(type, 2), reason } as ParticipantEvent;
      if (type === 'stopped' && reason === 'paid-overflow') {
        assert.equal(validateParticipantEvent(terminal), false);
        refusal(appendParticipantEvent(running(), terminal), 'invalid-event');
        continue;
      }
      assert.equal(validateParticipantEvent(terminal), true);
      const ended = accepted(appendParticipantEvent(running(), terminal));
      assert.equal(ended.reason, reason);
      assert.equal(conversationRunSerializedBytes(ended), Buffer.byteLength(JSON.stringify(ended)));
      assert.equal(validateConversationRun(structuredClone(ended)), true);
    }
  }
  for (const type of ['started', 'text', 'completed']) {
    assert.equal(validateParticipantEvent({ ...event('started'), type, reason: 'timeout', ...(type === 'text' ? { text: '' } : {}) }), false);
  }
  assert.equal(validateParticipantEvent({ ...event('failed'), reason: 'invented detail from a subprocess' }), false);
  assert.equal(validateConversationRun({ ...running(), reason: 'timeout' }), false);
});

test('a confirmed terminal across refused events closes as interrupted without inventing text or sequence', () => {
  const prefix = appendText(running(), 'Literal accepted prefix');
  const before = structuredClone(prefix);
  const terminal = { ...event('stopped', 5), type: 'stopped', reason: 'reply-too-long' } as const;
  const ended = accepted(closeConversationRun(prefix, { kind: 'interrupted', reason: 'event-refused', at: later, terminalEvent: terminal }));
  assert.equal(isConversationRunClosed(ended), true);
  assert.equal(ended.phase, 'running');
  assert.equal(ended.lastSequence, prefix.lastSequence);
  assert.equal(ended.updatedAt, prefix.updatedAt);
  assert.deepEqual(ended.outputChunks, prefix.outputChunks);
  assert.deepEqual(ended.closure, { kind: 'interrupted', reason: 'event-refused', at: later, terminalEvent: terminal });
  assert.equal(conversationRunSerializedBytes(ended), Buffer.byteLength(JSON.stringify(ended)));
  assert.equal(validateConversationRun(structuredClone(ended)), true);
  assert.deepEqual(prefix, before);
  refusal(appendParticipantEvent(ended, text('Late text', prefix.lastSequence + 1)), 'invalid-transition');
  refusal(closeConversationRun(ended, { kind: 'unknown', reason: 'user-closed', at: later }), 'invalid-transition');
});

test('explicit unknown closure ends local ownership without claiming the provider stopped', () => {
  for (const source of [prepared(), running(), { ...running(), phase: 'unknown' as const }]) {
    const ended = accepted(closeConversationRun(source, { kind: 'unknown', reason: 'user-closed', at: later }));
    assert.equal(ended.phase, source.phase);
    assert.equal(ended.lastSequence, source.lastSequence);
    assert.equal(ended.updatedAt, source.updatedAt);
    assert.equal(ended.closure?.kind, 'unknown');
    assert.equal(isConversationRunClosed(ended), true);
    assert.equal(validateConversationRun(structuredClone(ended)), true);
  }
  const terminal = accepted(appendParticipantEvent(running(), event('completed', 2)));
  assert.equal(isConversationRunClosed(terminal), true);
  refusal(closeConversationRun(terminal, { kind: 'unknown', reason: 'user-closed', at: later }), 'invalid-transition');
});

test('closure rejects wrong identities, forged terminal evidence, invalid dates and unsupported fields', () => {
  const run = appendText(running(), 'Prefix');
  const valid = { kind: 'interrupted', reason: 'workspace-limit', at: later, terminalEvent: event('completed', 4) };
  const bad: unknown[] = [
    { kind: 'unknown', reason: 'event-refused', at: later },
    { kind: 'unknown', reason: 'user-closed', at: later, terminalEvent: event('stopped', 4) },
    { ...valid, reason: 'user-closed' }, { ...valid, terminalEvent: undefined },
    { ...valid, terminalEvent: { ...event('stopped', 4), runId: ids.userMessageId } },
    { ...valid, terminalEvent: { ...event('stopped', 4), sessionId: ids.assistantMessageId } },
    { ...valid, terminalEvent: event('stopped', run.lastSequence) },
    { ...valid, terminalEvent: text('Not terminal', 4) },
    { ...valid, terminalEvent: { ...event('completed', 4), text: 'Unexpected text' } },
    { ...valid, at: '2026-10-08T12:00:00.000Z' },
    { ...valid, at: time, terminalEvent: { ...event('completed', 4), at: later } },
    { ...valid, at: 'not-a-date' }, { ...valid, extra: true },
  ];
  for (const closure of bad) {
    refusal(closeConversationRun(run, closure as ConversationRunClosure), 'invalid-closure');
    assert.equal(validateConversationRun({ ...run, closure }), false);
  }
});

test('new streams reserve closure space and legacy near-limit prefixes close without dropping text', () => {
  const fresh = running('i');
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...fresh, lastSequence: 2 }));
  const openBudget = MAX_RUN_SERIALIZED_BYTES - MAX_RUN_CLOSURE_BYTES;
  // Eight packed chunks cost 23 bytes beyond their escaped contents. Leave a
  // few bytes at the boundary; the next ordinary event must reserve recovery.
  const freshText = '\u0000'.repeat(Math.floor((openBudget - baseBytes - 32) / 6));
  const prefix = appendText(fresh, freshText);
  refusal(appendParticipantEvent(prefix, text('x'.repeat(64), prefix.lastSequence + 1)), 'run-size-limit');
  const recovered = accepted(closeConversationRun(prefix, { kind: 'interrupted', reason: 'event-refused', at: later,
    terminalEvent: { ...event('stopped', prefix.lastSequence + 2), type: 'stopped', reason: 'reply-too-long' } }));
  assert.ok(conversationRunSerializedBytes(recovered)! <= MAX_RUN_SERIALIZED_BYTES);
  assert.equal(recovered.outputChunks.join(''), freshText);
  assert.equal(validateConversationRun(structuredClone(recovered)), true);

  const legacyText = '\u0000'.repeat(Math.floor((MAX_RUN_SERIALIZED_BYTES - baseBytes - 32) / 6));
  const chunks = chunkRunText(legacyText);
  assert.equal(chunks.kind, 'ok');
  if (chunks.kind !== 'ok') return;
  const legacy: ConversationRun = { ...fresh, lastSequence: 2, outputChunks: chunks.chunks };
  const size = conversationRunSerializedBytes(legacy)!;
  assert.ok(size > MAX_RUN_SERIALIZED_BYTES - 32 && size <= MAX_RUN_SERIALIZED_BYTES);
  const closedLegacy = accepted(closeConversationRun(legacy, { kind: 'interrupted', reason: 'workspace-limit', at: later,
    terminalEvent: { ...event('failed', 5), type: 'failed', reason: 'process-error' } }));
  assert.ok(conversationRunSerializedBytes(closedLegacy)! > MAX_RUN_SERIALIZED_BYTES);
  assert.ok(conversationRunSerializedBytes(closedLegacy)! <= MAX_RUN_SERIALIZED_BYTES + MAX_RUN_CLOSURE_BYTES);
  assert.equal(closedLegacy.outputChunks.join(''), legacyText);
  assert.equal(closedLegacy.lastSequence, 2);
  assert.equal(validateConversationRun(structuredClone(closedLegacy)), true);
  assert.equal(conversationRunSerializedBytes(closedLegacy), Buffer.byteLength(JSON.stringify(closedLegacy)));
});

test('incremental metrics match independent serialization through Unicode, escapes and tail boundaries', () => {
  let run = running();
  const segments = ['a'.repeat(MAX_RUN_CHUNK_BYTES - 1), '🙂\n\u0000\\"é', '漢'.repeat(5000), '\t'.repeat(3000), '', 'end'];
  let literal = '';
  for (const segment of segments) {
    run = accepted(appendParticipantEvent(run, text(segment, run.lastSequence + 1)));
    literal += segment;
    assert.equal(run.outputChunks.join(''), literal);
    assert.equal(conversationRunSerializedBytes(run), Buffer.byteLength(JSON.stringify(run)));
    assert.equal(validateConversationRun(structuredClone(run)), true);
    assert.ok(run.outputChunks.every((chunk) => Buffer.byteLength(chunk) <= MAX_RUN_CHUNK_BYTES));
  }
});

test('thousands of small events preserve literal output without whole-reply rescans on the main thread', () => {
  let run = running();
  const literal = '0123456789abcdef';
  const before = performance.now();
  for (let index = 0; index < 8192; index++) {
    const result = appendParticipantEvent(run, text(literal, run.lastSequence + 1));
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') throw Error('Invented stream refused');
    run = result.run;
  }
  const elapsed = performance.now() - before;
  assert.equal(run.outputChunks.join(''), literal.repeat(8192));
  assert.equal(conversationRunSerializedBytes(run), Buffer.byteLength(JSON.stringify(run)));
  assert.equal(validateConversationRun(structuredClone(run)), true);
  assert.ok(elapsed < 3000, `8192 small events took ${Math.round(elapsed)}ms; the original whole-run loop took over 10 seconds.`);
});


test('cleanup acknowledgment preserves closed evidence and is an immutable local choice, not a stop result', () => {
  const prefix = appendText(running(), 'Retained literal prefix');
  const ended = accepted(appendParticipantEvent(prefix, { ...event('failed', 3), type: 'failed', reason: 'stop-incomplete' }));
  const snapshot = JSON.stringify(ended);
  const ack = accepted(acknowledgeUnreachableCleanup(ended, later));
  assert.equal(ack.reason, 'stop-incomplete');
  assert.deepEqual(ack.outputChunks, ended.outputChunks);
  assert.equal(ack.lastSequence, ended.lastSequence);
  assert.equal(ack.updatedAt, ended.updatedAt);
  assert.deepEqual(ack.cleanupAcknowledgment, { kind: 'unreachable', at: later });
  assert.equal(JSON.stringify(ended), snapshot);
  assert.ok(Object.isFrozen(ack.cleanupAcknowledgment));
  assert.equal(conversationRunSerializedBytes(ack), Buffer.byteLength(JSON.stringify(ack)));
  const restored = accepted(freezeConversationRun(JSON.parse(JSON.stringify(ack))));
  assert.deepEqual(restored, ack);
  refusal(acknowledgeUnreachableCleanup(prefix, later), 'invalid-transition');
  refusal(acknowledgeUnreachableCleanup(ack, later), 'invalid-transition');
  assert.equal(validateConversationRun({ ...ended, cleanupAcknowledgment: { kind: 'cleared', at: later } }), false);
  assert.equal(validateConversationRun({ ...ended, cleanupAcknowledgment: { kind: 'unreachable', at: '2020-01-01T00:00:00.000Z' } }), false);
  assert.equal(validateConversationRun({ ...prefix, cleanupAcknowledgment: { kind: 'unreachable', at: later } }), false);
  const mutable = structuredClone(ack);
  const captured = accepted(freezeConversationRun(mutable));
  mutable.cleanupAcknowledgment!.at = time;
  assert.equal(captured.cleanupAcknowledgment?.at, later);
});


test('legacy stopped paid-overflow evidence remains readable without accepting new malformed events', () => {
  const oldTerminal = { ...event('stopped', 3), type: 'stopped' as const, reason: 'paid-overflow' as const };
  const old = { ...running(), closure: { kind: 'interrupted', reason: 'event-refused', at: later, terminalEvent: oldTerminal } };
  assert.equal(validateParticipantEvent(oldTerminal), false);
  assert.equal(validateConversationRun(old), true);
  assert.deepEqual(accepted(freezeConversationRun(old)).closure?.kind, 'interrupted');
});

test('replay-lost closure requires an exact missing suffix and real terminal, retains prefix, and freezes independent evidence', () => {
  const prefix = accepted(appendParticipantEvent(running(), text('literal prefix')));
  const terminal = { ...event('completed', 6), type: 'completed' as const };
  const lost = { fromSequence: 3, throughSequence: 5, reason: 'restarted' as const };
  const closed = accepted(closeConversationRun(prefix, { kind: 'interrupted', reason: 'replay-lost', at: later, terminalEvent: terminal, lost }));
  assert.equal(closed.lastSequence, prefix.lastSequence);
  assert.deepEqual(closed.outputChunks, prefix.outputChunks);
  assert.equal(closed.phase, prefix.phase);
  lost.fromSequence = 99;
  if (closed.closure?.kind !== 'interrupted' || closed.closure.reason !== 'replay-lost') throw Error('closure');
  assert.equal(closed.closure.lost.fromSequence, 3);
  assert.equal(Object.isFrozen(closed.closure.lost), true);
  const serialized = JSON.parse(JSON.stringify(closed));
  assert.equal(validateConversationRun(serialized), true);
  assert.deepEqual(accepted(freezeConversationRun(serialized)), closed);
  for (const wrong of [
    { fromSequence: 2, throughSequence: 5, reason: 'restarted' },
    { fromSequence: 3, throughSequence: 4, reason: 'locked' },
    { fromSequence: 3, throughSequence: null, reason: 'closed' },
    { fromSequence: 3, throughSequence: 5, reason: 'invented' },
    { fromSequence: 3, throughSequence: 5, reason: 'replaced', extra: true },
  ]) {
    assert.equal(validateConversationRun({ ...serialized, closure: { ...serialized.closure, lost: wrong } }), false);
  }
  assert.equal(validateConversationRun({ ...serialized, closure: { ...serialized.closure, reason: 'event-refused' } }), false);
  assert.equal(validateConversationRun({ ...serialized, closure: { kind: 'unknown', reason: 'user-closed', at: later, lost: serialized.closure.lost } }), false);
});
