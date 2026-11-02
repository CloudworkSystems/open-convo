import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, DomainError } from '../../src/domain/commands';
import type { ConversationRun, ParticipantEvent } from '../../src/domain/conversation-run-types';
import { appendParticipantEvent, createConversationRun } from '../../src/domain/conversation-runs';
import { createDemoState } from '../../src/domain/demo';
import type { DeskState } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';
import { isStandardEmoji, MESSAGE_EMOJI_LIMIT } from '../../src/domain/message-marks';

const time = '2026-11-01T10:00:00.000Z';
const later = '2026-11-01T10:01:00.000Z';
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function fixture() {
  let count = 0;
  const options = { now: () => later, id: () => id(++count) };
  let state = createDemoState({ now: () => time, id: options.id });
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Invented question.' }, options);
  state = applyCommand(state, { type: 'send-demo', sessionId }, options);
  const user = state.messages.at(-2)!;
  const reply = state.messages.at(-1)!;
  return { state, options, sessionId, user, reply };
}

function withRun(f: ReturnType<typeof fixture>, finished: boolean): { state: DeskState; run: ConversationRun } {
  const created = createConversationRun({ runId: id(900), sessionId: f.sessionId, userMessageId: id(901), assistantMessageId: id(902),
    participant: { id: 'test-participant', label: 'Invented participant', model: 'test-model', executionHost: 'test-host' },
    input: 'Invented run input.', createdAt: later });
  assert.equal(created.kind, 'ok');
  let run = (created as { run: ConversationRun }).run;
  const events: { type: ParticipantEvent['type']; text?: string }[] = [{ type: 'started' }, { type: 'text', text: 'Invented reply.' }];
  if (finished) events.push({ type: 'completed' });
  for (const value of events) {
    const result = appendParticipantEvent(run, { runId: run.runId, sessionId: run.sessionId, sequence: run.lastSequence + 1, at: later, ...value } as ParticipantEvent);
    assert.equal(result.kind, 'ok');
    run = (result as { run: ConversationRun }).run;
  }
  return { state: { ...f.state, schemaVersion: 2, capabilities: { ...f.state.capabilities, provider: 'runtime-selected' }, conversationRuns: [run] }, run };
}

function refuses(operation: () => unknown, message: string) {
  assert.throws(operation, (error) => error instanceof DomainError && error.message === message);
}

test('a workspace without marks stays valid and gains no field until the owner marks a message', () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.state, 'messageMarks'), false);
  assert.equal(validateState(f.state).valid, true);
});

test('rating a reply saves one mark, a second press clears it, and the other rating replaces it', () => {
  const f = fixture();
  const up = applyCommand(f.state, { type: 'set-message-rating', messageId: f.reply.id, rating: 'up' }, f.options);
  assert.deepEqual(up.messageMarks, [{ messageId: f.reply.id, rating: 'up', updatedAt: later }]);
  assert.equal(up.revision, f.state.revision + 1);
  assert.equal(validateState(up).valid, true);
  // Nothing else changes: no activity entry, messages untouched.
  assert.deepEqual(up.messages, f.state.messages);
  assert.deepEqual(up.activity, f.state.activity);
  const down = applyCommand(up, { type: 'set-message-rating', messageId: f.reply.id, rating: 'down' }, f.options);
  assert.equal(down.messageMarks?.[0].rating, 'down');
  const cleared = applyCommand(down, { type: 'set-message-rating', messageId: f.reply.id, rating: null }, f.options);
  assert.deepEqual(cleared.messageMarks, []);
  assert.equal(validateState(cleared).valid, true);
  assert.equal(applyCommand(cleared, { type: 'set-message-rating', messageId: f.reply.id, rating: null }, f.options), cleared);
});

test('reactions toggle, keep a fixed order, and sit beside a rating', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'idea' }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  state = applyCommand(state, { type: 'set-message-rating', messageId: f.reply.id, rating: 'up' }, f.options);
  assert.deepEqual(state.messageMarks?.[0].reactions, ['heart', 'idea']);
  assert.equal(state.messageMarks?.[0].rating, 'up');
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  assert.deepEqual(state.messageMarks?.[0].reactions, ['idea']);
  assert.equal(validateState(state).valid, true);
});

test('the owner can react to his own message but not rate it', () => {
  const f = fixture();
  const reacted = applyCommand(f.state, { type: 'toggle-message-reaction', messageId: f.user.id, reaction: 'check' }, f.options);
  assert.deepEqual(reacted.messageMarks, [{ messageId: f.user.id, reactions: ['check'], updatedAt: later }]);
  refuses(() => applyCommand(f.state, { type: 'set-message-rating', messageId: f.user.id, rating: 'up' }, f.options), 'Only replies can be rated.');
});

test('unknown messages and reactions are refused without a change', () => {
  const f = fixture();
  refuses(() => applyCommand(f.state, { type: 'set-message-rating', messageId: id(999), rating: 'up' }, f.options), 'That message no longer exists. Nothing was changed.');
  refuses(() => applyCommand(f.state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'fire' as never }, f.options), 'That reaction is not available.');
});

test('run messages can be marked once the reply has ended, and not while it is being written', () => {
  const running = withRun(fixture(), false);
  assert.equal(validateState(running.state).valid, true);
  refuses(() => applyCommand(running.state, { type: 'set-message-rating', messageId: running.run.assistantMessageId, rating: 'up' }),
    'Wait until this reply has ended to rate or react to it.');
  // The owner's own message in a run has been sent, so it can take a reaction.
  const userMarked = applyCommand(running.state, { type: 'toggle-message-reaction', messageId: running.run.userMessageId, reaction: 'eyes' });
  assert.equal(validateState(userMarked).valid, true);
  const done = withRun(fixture(), true);
  const rated = applyCommand(done.state, { type: 'set-message-rating', messageId: done.run.assistantMessageId, rating: 'down' });
  assert.equal(rated.messageMarks?.[0].messageId, done.run.assistantMessageId);
  assert.equal(validateState(rated).valid, true);
  // Marks never enter the run record, whose shape the participant contract fixes.
  assert.deepEqual(rated.conversationRuns, done.state.conversationRuns);
});

test('saved marks that are corrupt or point nowhere are refused, never repaired', () => {
  const f = fixture();
  const good = applyCommand(f.state, { type: 'set-message-rating', messageId: f.reply.id, rating: 'up' }, f.options);
  const mark = good.messageMarks![0];
  const bad: unknown[] = [
    { ...good, messageMarks: [{ ...mark, messageId: id(999) }] },
    { ...good, messageMarks: [{ ...mark, rating: 'meh' }] },
    { ...good, messageMarks: [{ messageId: f.user.id, rating: 'up', updatedAt: later }] },
    { ...good, messageMarks: [{ messageId: f.reply.id, updatedAt: later }] },
    { ...good, messageMarks: [{ ...mark, reactions: [] }] },
    { ...good, messageMarks: [{ ...mark, reactions: ['idea', 'heart'] }] },
    { ...good, messageMarks: [{ ...mark, reactions: ['heart', 'heart'] }] },
    { ...good, messageMarks: [{ ...mark, note: 'extra' }] },
    { ...good, messageMarks: [mark, mark] },
    { ...good, messageMarks: [{ ...mark, updatedAt: '2099-01-01T00:00:00.000Z' }] },
    { ...good, messageMarks: {} },
  ];
  for (const state of bad) assert.equal(validateState(state).valid, false, JSON.stringify((state as DeskState).messageMarks));
});

test('any standard emoji can be added from the full set, and the quick ones stay one mark', async () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '🦊' }, f.options);
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.user.id, emoji: '👍🏽' }, f.options);
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '🇨🇦' }, f.options);
  assert.deepEqual(state.messageMarks?.find((mark) => mark.messageId === f.reply.id)?.emoji, ['🦊', '🇨🇦']);
  assert.equal(validateState(state).valid, true);
  // ❤️ from the full set is the same mark as the quick heart.
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '❤️' }, f.options);
  const reply = state.messageMarks?.find((mark) => mark.messageId === f.reply.id);
  assert.deepEqual(reply?.reactions, ['heart']);
  assert.deepEqual(reply?.emoji, ['🦊', '🇨🇦']);
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '🦊' }, f.options);
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '🇨🇦' }, f.options);
  assert.equal(Object.hasOwn(state.messageMarks!.find((mark) => mark.messageId === f.reply.id)!, 'emoji'), false);
  for (const text of ['a', 'hi 🙂', '12', '#', '']) {
    refuses(() => applyCommand(f.state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: text }, f.options), 'That emoji is not available.');
  }
  const { default: data } = await import('../../src/content/emoji.json', { with: { type: 'json' } });
  const every = (data as { groups: { emoji: string[][] }[] }).groups.flatMap((group) => group.emoji);
  assert.equal(every.length, 1914);
  for (const [emoji] of every) assert.equal(isStandardEmoji(emoji), true, emoji);
});

test('a message holds at most the stated number of emoji, and corrupt emoji lists are refused', () => {
  const f = fixture();
  let state = f.state;
  const many = ['🦊', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴'];
  assert.equal(many.length, MESSAGE_EMOJI_LIMIT);
  for (const emoji of many) state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji }, f.options);
  assert.equal(validateState(state).valid, true);
  refuses(() => applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '🦄' }, f.options),
    `A message can hold up to ${MESSAGE_EMOJI_LIMIT} emoji. Remove one first.`);
  const good = applyCommand(f.state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '🦊' }, f.options);
  const mark = good.messageMarks![0];
  const bad: unknown[] = [
    { ...good, messageMarks: [{ ...mark, emoji: [] }] },
    { ...good, messageMarks: [{ ...mark, emoji: ['🦊', '🦊'] }] },
    { ...good, messageMarks: [{ ...mark, emoji: ['fox'] }] },
    { ...good, messageMarks: [{ ...mark, emoji: ['❤️'] }] },
    { ...good, messageMarks: [{ ...mark, emoji: [...many, '🦄'] }] },
    { ...good, messageMarks: [{ ...mark, emoji: '🦊' }] },
  ];
  for (const value of bad) assert.equal(validateState(value).valid, false, JSON.stringify((value as DeskState).messageMarks));
});
