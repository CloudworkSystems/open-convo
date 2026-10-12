import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository, type StorageLike } from '../../src/adapters/browser-repository';
import { applyCommand, DomainError, isViewCommand } from '../../src/domain/commands';
import { createConversationRun } from '../../src/domain/conversation-runs';
import { prepareConversationRun } from '../../src/domain/conversation-workspace';
import { createDemoState } from '../../src/domain/demo';
import { participantChoiceKey, sameParticipantIdentity, validParticipantChoice, validParticipantIdentity, type ParticipantChoice } from '../../src/domain/participant-choices';
import type { ParticipantIdentity } from '../../src/domain/conversation-run-types';
import type { DeskCommand } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

const time = '2026-10-10T16:00:00.000Z';
const later = '2026-10-10T16:01:00.000Z';
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const identity: ParticipantIdentity = { id: 'invented-worker', label: 'Invented participant', model: 'invented-model', executionHost: 'Invented host' };
const choice = (patch: Partial<ParticipantChoice> = {}): ParticipantChoice => ({ identity: { ...identity },
  provider: 'Invented provider', destination: 'Invented cloud destination', approved: true,
  available: false, unavailableReason: 'Live sending is not connected.', ...patch });
function fixture() {
  let next = 0;
  return createDemoState({ id: () => id(++next), now: () => time });
}
const command = (sessionId: string, participant = identity): DeskCommand => ({ type: 'set-participant-choice', sessionId, participant });
const options = { now: () => later, id: () => id(90) };

test('legacy workspace reading leaves the participant preference absent without selecting a default', () => {
  const state = fixture();
  const before = JSON.stringify(state);
  assert.equal(validateState(state).valid, true);
  assert.equal(Object.hasOwn(state.sessions[0], 'participantChoice'), false);
  assert.equal(JSON.stringify(state), before);
});

test('participant choice is a durable content edit that reopens without storing eligibility or availability', async () => {
  const state = fixture();
  const values = new Map<string, string>();
  const storage: StorageLike = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const repository = new BrowserRepository(storage, async (operation) => operation());
  assert.equal((await repository.save(state, null)).kind, 'saved');
  const edit = command(state.sessions[0].id);
  assert.equal(isViewCommand(edit), false);
  const next = applyCommand(state, edit, options);
  assert.equal(next.revision, state.revision + 1);
  assert.equal(next.updatedAt, later);
  assert.equal(next.sessions[0].updatedAt, later);
  assert.equal(next.schemaVersion, 1);
  assert.equal((await repository.save(next, state.revision)).kind, 'saved');
  const reopened = await new BrowserRepository(storage, async (operation) => operation()).loadLatest();
  assert.equal(reopened.kind, 'ready');
  if (reopened.kind !== 'ready') throw new Error('Saved invented workspace did not reopen.');
  assert.deepEqual(reopened.state.sessions[0].participantChoice, identity);
  assert.deepEqual(Object.keys(reopened.state.sessions[0].participantChoice!).sort(), ['executionHost', 'id', 'label', 'model']);
  assert.deepEqual(reopened.state.capabilities, state.capabilities);
});

test('choice belongs to its explicit session and changes neither old run evidence nor unsent drafts', () => {
  let state = fixture();
  const first = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId: first, text: 'Invented first message' }, options);
  const prepared = createConversationRun({ runId: id(100), sessionId: first, userMessageId: id(101), assistantMessageId: id(102),
    participant: identity, input: 'Invented first message', createdAt: later });
  if (prepared.kind !== 'ok') throw new Error('Invented run could not be prepared.');
  state = prepareConversationRun(state, prepared.run, 'Invented first message');
  let nextId = 110;
  state = applyCommand(state, { type: 'create-session', goalId: state.goals[0].id, title: 'Invented second session' },
    { now: () => later, id: () => id(++nextId) });
  state = applyCommand(state, { type: 'set-draft', sessionId: first, text: 'Keep this unsent draft' }, options);
  const before = JSON.stringify(state);
  const selected = { ...identity, model: 'another-invented-model' };
  const next = applyCommand(state, command(first, selected), options);
  assert.equal(validateState(next).valid, true);
  assert.equal(next.schemaVersion, 2);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(next.drafts, state.drafts);
  assert.deepEqual(next.messages, state.messages);
  assert.deepEqual(next.conversationRuns, state.conversationRuns);
  assert.deepEqual(next.selection, state.selection);
  assert.deepEqual(next.sessions.find((session) => session.id === first)?.participantChoice, selected);
  assert.equal(Object.hasOwn(next.sessions[1], 'participantChoice'), false);
  selected.model = 'mutated-after-command';
  assert.equal(next.sessions[0].participantChoice?.model, 'another-invented-model');
});

test('choosing the same exact identity is a no-op and every identity field participates in equality and keys', () => {
  const state = fixture();
  const chosen = applyCommand(state, command(state.sessions[0].id), options);
  assert.equal(applyCommand(chosen, command(state.sessions[0].id, { ...identity }), options), chosen);
  assert.equal(sameParticipantIdentity(identity, { ...identity }), true);
  const keys = new Set([participantChoiceKey(identity)]);
  for (const field of ['id', 'label', 'model', 'executionHost'] as const) {
    const different = { ...identity, [field]: `${identity[field]} different` };
    assert.equal(sameParticipantIdentity(identity, different), false);
    keys.add(participantChoiceKey(different));
  }
  assert.equal(keys.size, 5);
  assert.notEqual(participantChoiceKey({ ...identity, id: 'a,b', label: 'c' }), participantChoiceKey({ ...identity, id: 'a', label: 'b,c' }));
});

test('literal identities reject extra fields, malformed Unicode and overlong UTF-8 without truncation or accessor evaluation', () => {
  assert.equal(validParticipantIdentity(identity), true);
  assert.equal(validParticipantIdentity({ ...identity, model: '🧪'.repeat(64) }), true);
  const invalid: unknown[] = [null, [], {}, { ...identity, approved: true }, { ...identity, model: ' ' },
    { ...identity, id: 12 }, { ...identity, model: 'a'.repeat(257) }, { ...identity, model: '🧪'.repeat(65) },
    { ...identity, label: '\ud800' }, { ...identity, executionHost: '\udc00' },
    Object.assign(Object.create(identity), {}), { ...identity, [Symbol('hidden')]: true }];
  const accessor = { ...identity };
  Object.defineProperty(accessor, 'model', { enumerable: true, get() { throw new Error('Must not evaluate an accessor.'); } });
  invalid.push(accessor);
  const hidden = { ...identity };
  Object.defineProperty(hidden, 'model', { enumerable: false, value: 'invented-model' });
  invalid.push(hidden);
  const state = fixture();
  const before = JSON.stringify(state);
  for (const participant of invalid) {
    assert.equal(validParticipantIdentity(participant), false);
    assert.throws(() => applyCommand(state, command(state.sessions[0].id, participant as ParticipantIdentity), options), DomainError);
    assert.equal(validateState({ ...state, sessions: [{ ...state.sessions[0], participantChoice: participant }] }).valid, false);
  }
  assert.equal(JSON.stringify(state), before);
});

test('catalog eligibility stays separate from availability and unavailable entries require an honest bounded reason', () => {
  assert.equal(validParticipantChoice(choice()), true);
  assert.equal(validParticipantChoice(choice({ approved: false })), true);
  assert.equal(validParticipantChoice(choice({ approved: false, available: true, unavailableReason: null })), true);
  const invalid: unknown[] = [null, [], { ...choice(), extra: true }, { ...choice(), approved: 'yes' },
    { ...choice(), available: 'yes' }, choice({ available: true }), choice({ unavailableReason: null }),
    choice({ unavailableReason: ' ' }), choice({ unavailableReason: 'a'.repeat(257) }),
    choice({ provider: '' }), choice({ destination: '\ud800' }), choice({ provider: '🧪'.repeat(65) }),
    choice({ identity: { ...identity, model: '' } })];
  for (const value of invalid) assert.equal(validParticipantChoice(value), false);
});

test('catalog authority fields cannot be smuggled into a saved preference or clearing command', () => {
  const state = fixture();
  for (const invalid of [choice(), { ...identity, approved: true }, undefined, null]) {
    assert.throws(() => applyCommand(state, { type: 'set-participant-choice', sessionId: state.sessions[0].id,
      participant: invalid as ParticipantIdentity }, options), DomainError);
    assert.equal(validateState({ ...state, sessions: [{ ...state.sessions[0], participantChoice: invalid }] }).valid, false);
  }
  assert.throws(() => applyCommand(state, command(id(900)), options), /session no longer exists/);
});
