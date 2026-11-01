import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, DomainError } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { sideChatTitle } from '../../src/domain/side-chat';
import type { DeskState } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

const time = '2026-11-01T10:00:00.000Z';
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function fixture() {
  let count = 0;
  const options = { now: () => time, id: () => id(++count) };
  let state = createDemoState(options);
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Invented question.' }, options);
  state = applyCommand(state, { type: 'send-demo', sessionId }, options);
  return { state, options, sessionId, reply: state.messages.at(-1)! };
}

test('a side chat is a new linked conversation whose draft quotes only that message', () => {
  const f = fixture();
  const next = applyCommand(f.state, { type: 'create-side-chat', messageId: f.reply.id, text: f.reply.body }, f.options);
  const side = next.sessions.at(-1)!;
  assert.deepEqual(side.sideOf, { sessionId: f.sessionId, messageId: f.reply.id });
  assert.equal(side.goalId, f.state.sessions[0].goalId);
  assert.ok(side.title.startsWith('Side chat: '));
  assert.equal(next.selection.sessionId, side.id);
  assert.ok(next.drafts[side.id].startsWith('> '));
  assert.ok(next.drafts[side.id].endsWith('\n\n'));
  // The main conversation is untouched: no messages added, its draft kept.
  assert.deepEqual(next.messages, f.state.messages);
  assert.equal(next.drafts[f.sessionId], f.state.drafts[f.sessionId]);
  assert.equal(validateState(next).valid, true);
});

test('a side chat copies the saved participant choice, which sending still checks', () => {
  const f = fixture();
  const participant = { id: 'test-participant', label: 'Invented participant', model: 'test-model', executionHost: 'test-host' };
  const chosen = applyCommand(f.state, { type: 'set-participant-choice', sessionId: f.sessionId, participant }, f.options);
  const next = applyCommand(chosen, { type: 'create-side-chat', messageId: f.reply.id, text: 'x' }, f.options);
  assert.deepEqual(next.sessions.at(-1)!.participantChoice, participant);
});

test('a side chat about a missing message is refused', () => {
  const f = fixture();
  assert.throws(() => applyCommand(f.state, { type: 'create-side-chat', messageId: id(999), text: 'x' }, f.options),
    (error) => error instanceof DomainError && error.message === 'That message no longer exists. Nothing was changed.');
});

test('titles are one short line', () => {
  assert.equal(sideChatTitle('Line one\nline   two'), 'Side chat: Line one line two');
  assert.equal(sideChatTitle('a'.repeat(80)), `Side chat: ${'a'.repeat(60)}…`);
  assert.equal(sideChatTitle('   '), 'Side chat: a message');
});

test('saved links that point nowhere, at the wrong conversation, or in a loop are refused', () => {
  const f = fixture();
  const next = applyCommand(f.state, { type: 'create-side-chat', messageId: f.reply.id, text: 'x' }, f.options);
  const side = next.sessions.at(-1)!;
  const withLink = (sideOf: unknown, extra: Partial<DeskState> = {}) => ({ ...next, ...extra,
    sessions: next.sessions.map((session) => session.id === side.id ? { ...session, sideOf } : session) });
  assert.equal(validateState(withLink({ sessionId: id(999), messageId: f.reply.id })).valid, false);
  assert.equal(validateState(withLink({ sessionId: f.sessionId, messageId: id(999) })).valid, false);
  assert.equal(validateState(withLink({ sessionId: side.id, messageId: f.reply.id })).valid, false);
  assert.equal(validateState(withLink({ sessionId: f.sessionId, messageId: f.reply.id, extra: 1 })).valid, false);
  assert.equal(validateState(withLink(null)).valid, false);
  // The parent itself made a side chat of the side chat: a loop.
  const looped = { ...next, sessions: next.sessions.map((session) => session.id === f.sessionId
    ? { ...session, sideOf: { sessionId: side.id, messageId: f.reply.id } } : session) };
  assert.equal(validateState(looped).valid, false);
});
