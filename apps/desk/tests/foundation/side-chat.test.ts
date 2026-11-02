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

test('moving a conversation or one of its side chats to a folder moves the whole linked group', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'create-side-chat', messageId: f.reply.id, text: f.reply.body }, f.options);
  const side = state.sessions.at(-1)!;
  // A side chat of the side chat, so the group has three levels.
  state = applyCommand(state, { type: 'set-draft', sessionId: side.id, text: 'Invented follow-up.' }, f.options);
  state = applyCommand(state, { type: 'send-demo', sessionId: side.id }, f.options);
  const nestedReply = state.messages.at(-1)!;
  state = applyCommand(state, { type: 'create-side-chat', messageId: nestedReply.id, text: nestedReply.body }, f.options);
  const nested = state.sessions.at(-1)!;
  const group = [f.sessionId, side.id, nested.id];
  state = applyCommand(state, { type: 'create-session', goalId: f.state.sessions[0].goalId, title: 'Invented unrelated session' }, f.options);
  state = applyCommand(state, { type: 'create-goal', title: 'Invented other folder', empty: true }, f.options);
  const other = state.goals.at(-1)!;
  state = applyCommand(state, { type: 'select-session', sessionId: nested.id }, f.options);
  const goalOf = (value: DeskState, sessionId: string) => value.sessions.find((session) => session.id === sessionId)!.goalId;
  // Moving the nested side chat moves its parent and grandparent too.
  const moved = applyCommand(state, { type: 'move-session', sessionId: nested.id, goalId: other.id }, f.options);
  for (const sessionId of group) assert.equal(goalOf(moved, sessionId), other.id);
  assert.equal(moved.selection.goalId, other.id);
  assert.equal(validateState(moved).valid, true);
  // Moving the parent back brings its side chats with it, and nothing else moves.
  const back = applyCommand(moved, { type: 'move-session', sessionId: f.sessionId, goalId: null }, f.options);
  for (const sessionId of group) assert.equal(goalOf(back, sessionId), null);
  for (const session of back.sessions.filter((entry) => !group.includes(entry.id))) {
    assert.equal(session.goalId, state.sessions.find((entry) => entry.id === session.id)!.goalId);
  }
  assert.equal(applyCommand(back, { type: 'move-session', sessionId: side.id, goalId: null }, f.options), back);
});
