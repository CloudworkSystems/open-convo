import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeProofCodec, type NativeProofRequest } from '../../src/adapters/native-host-codec';
import { decodeNativeParticipantPush } from '../../src/adapters/native-participant-codec';
import { validateState } from '../../src/domain/validation';
import { ANTHROPIC_EXECUTION_HOST, CLAUDE_PARTICIPANT_ID, carriesContext, createConversationRun, freezeConversationRun,
  validateConversationRun } from '../../src/domain/conversation-runs';

// Revision 5 (contract section 21): invented Claude Code adapter vectors. The
// page-level cases run here; the seeded host cases (adapter PR 3e) run in
// Swift, and the page checks what it would see of them.
type Wire = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-participant-claude-v1.json', import.meta.url), 'utf8')) as {
  context: { claudeParticipant: Wire; revision3Participant: Wire; localParticipant: Wire; stdinPreamble: string };
  records: Record<string, Wire>;
  cases: { name: string; request: Wire; reply: Wire; seed?: Wire; pushed?: Wire[]; afterRuns?: Wire[]; stdin?: string }[];
  invalidReplies: { name: string; basedOn: string; reply: Wire }[];
  runs: { valid: { name: string; run: Wire }[]; invalid: { name: string; run: Wire }[] };
  stdinLayouts: { name: string; turns: { role: 'user' | 'assistant'; text: string }[]; message: string; stdin: string;
    contextBytes: number; inputBytes: number; countedBytes: number; firstTrialBound: number; withinFirstTrialBound: boolean }[];
};
const v3 = JSON.parse(readFileSync(new URL('../fixtures/native-participant-v1.json', import.meta.url), 'utf8')) as {
  cases: { name: string; request: Wire; reply: Wire }[];
};
const pageCases = fixture.cases.filter(entry => entry.seed === undefined);
const hostCases = fixture.cases.filter(entry => entry.seed !== undefined);
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
  assert.equal(pageCases.length, 8);
  for (const entry of pageCases) {
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
    const base = pageCases.find(c => c.name === entry.basedOn);
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

// Adapter PR 3e: the seeded host cases. The Swift harness replays each one
// against the fake CLI; here the page checks what it would see of them.
const byName = new Map(fixture.cases.map(entry => [entry.name, entry]));
const chainOf = (entry: (typeof fixture.cases)[number]) => {
  const chain = [entry];
  while (chain[0]!.seed?.afterCase) chain.unshift(byName.get(chain[0]!.seed.afterCase)!);
  return chain;
};
const join = (chunks: string[]) => chunks.join('');

test('host cases: eleven, after the page-level cases, each rooted in the off-Mac pin', () => {
  assert.equal(hostCases.length, 11);
  assert.deepEqual(fixture.cases.slice(0, 8), pageCases);
  for (const entry of hostCases) assert.deepEqual(chainOf(entry)[0]!.seed!.pin, fixture.context.claudeParticipant, entry.name);
});

test('host cases: every seeded record is one the page could have saved', () => {
  assert.deepEqual(Object.keys(fixture.records), ['claude-earlier-r4', 'claude-prepared-r5', 'claude-long-prepared-r5']);
  for (const [name, record] of Object.entries(fixture.records)) assert.equal(validateState(structuredClone(record)).valid, true, name);
});

test('host cases: every reply decodes on the page, and every pushed participant event decodes in order', () => {
  for (const entry of hostCases) {
    const result = codecFor(entry.request).decode(JSON.stringify(entry.reply));
    assert.ok(result, entry.name);
    let last = 0;
    for (const detail of entry.pushed ?? []) {
      if (detail.type === 'host.connection') continue;
      const decoded = decodeNativeParticipantPush({ connectionId: detail.connectionId, documentGeneration: detail.generation }, detail);
      assert.ok(decoded, entry.name);
      assert.ok(decoded.sequence > last, entry.name);
      last = decoded.sequence;
    }
  }
});

test('host cases: each saved ending is the last event the page received', () => {
  for (const entry of hostCases) {
    const ending = (entry.pushed ?? []).map(detail => detail.event).filter(event => event && !['started', 'text'].includes(event.type)).at(-1);
    if (!ending || !entry.afterRuns) continue;
    const saved = entry.afterRuns.find(run => run.runId === ending.runId)!;
    assert.deepEqual(saved.terminal, { type: ending.type, sequence: ending.sequence, at: ending.at, reason: ending.reason ?? null }, entry.name);
  }
});

test('host cases: what reached the CLI. Only an accepted start launches, with the earlier turn then the new message in section 21.3\'s layout; the runs list holds no conversation text', () => {
  const launched: string[] = [];
  for (const entry of hostCases) {
    const started = entry.request.operation === 'participant.start' && entry.reply.outcome === 'ok';
    if (entry.stdin === undefined) continue;
    assert.ok(started, entry.name);
    launched.push(entry.name);
    const root = chainOf(entry)[0]!;
    const record = (root.request.payload.record ?? fixture.records[root.seed!.record]) as Wire;
    const runs = record.conversationRuns as Wire[];
    const run = runs.find(r => r.runId === entry.request.payload.runId)!;
    const turns = (run.contextRunIds as string[]).flatMap(id => {
      const earlier = runs.find(r => r.runId === id)!;
      return [{ role: 'user', text: join(earlier.inputChunks) }, { role: 'assistant', text: join(earlier.outputChunks) }];
    });
    assert.equal(turns.length, 2, entry.name);
    assert.equal(entry.stdin, layout(turns, join(entry.request.payload.inputChunks)), entry.name);
  }
  assert.equal(launched.length, 4);
  for (const entry of hostCases) {
    for (const saved of entry.afterRuns ?? []) {
      assert.deepEqual(saved.participant, fixture.context.claudeParticipant, entry.name);
      assert.ok('contextRunIds' in saved && 'contextBytes' in saved && 'contextHash' in saved, entry.name);
      const text = JSON.stringify(saved);
      for (const turn of ['Invented note: my invented bakery is called Maple Crumb.', 'Noted: Maple Crumb.', 'Maple Crumb. ']) {
        assert.ok(!text.includes(turn), `${entry.name}: the runs list holds no conversation text`);
      }
    }
  }
});
