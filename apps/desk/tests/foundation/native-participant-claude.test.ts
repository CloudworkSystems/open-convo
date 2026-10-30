import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeProofCodec, type NativeProofRequest } from '../../src/adapters/native-host-codec';
import { ANTHROPIC_EXECUTION_HOST, CLAUDE_PARTICIPANT_ID, carriesContext, createConversationRun, freezeConversationRun,
  validateConversationRun } from '../../src/domain/conversation-runs';

// Revision 5 (contract section 21): invented Claude Code adapter vectors, page side only.
type Wire = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-participant-claude-v1.json', import.meta.url), 'utf8')) as {
  context: { claudeParticipant: Wire; revision3Participant: Wire; localParticipant: Wire; stdinPreamble: string };
  cases: { name: string; request: Wire; reply: Wire }[];
  invalidReplies: { name: string; basedOn: string; reply: Wire }[];
  runs: { valid: { name: string; run: Wire }[]; invalid: { name: string; run: Wire }[] };
  stdinLayouts: { name: string; turns: { role: 'user' | 'assistant'; text: string }[]; message: string; stdin: string;
    contextBytes: number; inputBytes: number; countedBytes: number; firstTrialBound: number; withinFirstTrialBound: boolean }[];
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
const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

test('every revision-5 fixture prepares and decodes to its exact result', () => {
  assert.equal(fixture.cases.length, 8);
  for (const entry of fixture.cases) {
    const result = codecFor(entry.request).decode(JSON.stringify(entry.reply));
    assert.ok(result, entry.name);
    assert.deepEqual(result.result, strip(entry.reply), entry.name);
  }
});

test('the off-Mac pin names Anthropic, never this Mac', () => {
  assert.equal(CLAUDE_PARTICIPANT_ID, 'claude-code');
  assert.equal(ANTHROPIC_EXECUTION_HOST, 'anthropic');
  assert.deepEqual(fixture.context.claudeParticipant,
    { id: 'claude-code', label: 'Claude', model: 'invented-pinned-model', executionHost: 'anthropic' });
  for (const entry of fixture.cases) {
    if (entry.reply.operation !== 'participant.availability') continue;
    assert.equal(entry.reply.participants[0].executionHost, 'anthropic', entry.name);
  }
});

test('the page codec refuses every malformed revision-5 reply', () => {
  assert.equal(fixture.invalidReplies.length, 7);
  for (const entry of fixture.invalidReplies) {
    const base = fixture.cases.find(c => c.name === entry.basedOn);
    assert.ok(base, entry.name);
    assert.equal(codecFor(base.request).decode(JSON.stringify(entry.reply)), undefined, entry.name);
  }
});

test('revision-3 availability stays valid and can never carry host-not-approved', () => {
  for (const entry of v3.cases.filter(c => c.request.operation === 'participant.availability' && c.reply.outcome === 'ok')) {
    assert.ok(codecFor(entry.request).decode(JSON.stringify(entry.reply)), entry.name);
    const changed = structuredClone(entry.reply);
    changed.participants[0].available = false;
    changed.participants[0].reason = 'host-not-approved';
    delete changed.participants[0].confirmation;
    assert.equal(codecFor(entry.request).decode(JSON.stringify(changed)), undefined, entry.name);
  }
});

test('prepared runs carry contextRunIds exactly when their pin carries context', () => {
  assert.equal(carriesContext(fixture.context.claudeParticipant as never), true);
  assert.equal(carriesContext(fixture.context.localParticipant as never), true);
  assert.equal(carriesContext(fixture.context.revision3Participant as never), false);
  for (const entry of fixture.runs.valid) {
    assert.equal(validateConversationRun(structuredClone(entry.run)), true, entry.name);
    const frozen = freezeConversationRun(structuredClone(entry.run));
    assert.equal(frozen.kind, 'ok', entry.name);
    if (frozen.kind === 'ok' && frozen.run.contextRunIds) assert.ok(Object.isFrozen(frozen.run.contextRunIds), entry.name);
  }
  for (const entry of fixture.runs.invalid) assert.equal(validateConversationRun(structuredClone(entry.run)), false, entry.name);
});

test('creating an off-Mac Claude run requires context ids; the revision-3 pin still refuses them', () => {
  const args = { runId: '71abcdef-0000-4000-8abc-000000001120', sessionId: '52abcdef-0000-4000-8abc-000000001101',
    userMessageId: '72abcdef-0000-4000-8abc-000000001120', assistantMessageId: '73abcdef-0000-4000-8abc-000000001120',
    input: 'Invented question.', createdAt: '2026-10-29T04:00:00.000Z' };
  const claude = fixture.context.claudeParticipant as { id: string; label: string; model: string; executionHost: string };
  const rev3 = fixture.context.revision3Participant as { id: string; label: string; model: string; executionHost: string };
  const made = createConversationRun({ ...args, participant: claude, contextRunIds: ['71abcdef-0000-4000-8abc-000000001101'] });
  assert.equal(made.kind, 'ok');
  if (made.kind === 'ok') assert.deepEqual(made.run.contextRunIds, ['71abcdef-0000-4000-8abc-000000001101']);
  assert.equal(createConversationRun({ ...args, participant: claude, contextRunIds: [] }).kind, 'ok');
  assert.deepEqual(createConversationRun({ ...args, participant: claude }), { kind: 'refused', reason: 'invalid-arguments' });
  assert.deepEqual(createConversationRun({ ...args, participant: rev3, contextRunIds: [] }), { kind: 'refused', reason: 'invalid-arguments' });
  assert.equal(createConversationRun({ ...args, participant: rev3 }).kind, 'ok');
});

// Section 21.3's layout, written out here from the contract's words so the
// vectors that native's launcher (PR 3c) must match are checked against them.
function layout(turns: readonly { role: string; text: string }[], message: string): string {
  if (turns.length === 0) return message;
  return `${fixture.context.stdinPreamble}\n\n`
    + turns.map(turn => `[earlier ${turn.role} turn, ${utf8(turn.text)} bytes]\n${turn.text}\n\n`).join('')
    + `[new message, ${utf8(message)} bytes]\n${message}`;
}

test('the stdin layout vectors follow section 21.3 and count only turn text against the bound', () => {
  assert.equal(fixture.stdinLayouts.length, 5);
  assert.equal(fixture.stdinLayouts[0]!.stdin, fixture.stdinLayouts[0]!.message);
  for (const entry of fixture.stdinLayouts) {
    assert.equal(entry.stdin, layout(entry.turns, entry.message), entry.name);
    assert.equal(entry.contextBytes, entry.turns.reduce((total, turn) => total + utf8(turn.text), 0), entry.name);
    assert.equal(entry.inputBytes, utf8(entry.message), entry.name);
    assert.equal(entry.countedBytes, entry.contextBytes + entry.inputBytes, entry.name);
    assert.equal(entry.firstTrialBound, 4096, entry.name);
    assert.equal(entry.withinFirstTrialBound, entry.countedBytes <= 4096, entry.name);
  }
});
