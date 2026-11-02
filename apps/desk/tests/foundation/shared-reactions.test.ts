import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, DomainError } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import type { ConversationRun } from '../../src/domain/conversation-run-types';
import {
  contextRunsFor, reactionsLine, reactionsNoteEdited, reactionsNoteSendHold, reactionSharingOn, splitReactionsNote,
} from '../../src/domain/shared-reactions';
import { validateState } from '../../src/domain/validation';
import { draftWithReplyQuote } from '../../src/domain/reply-quote';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const local = { id: 'local-test', label: 'Invented local model', model: 'invented:1', executionHost: 'this-mac' };
const other = { id: 'other-test', label: 'Invented other model', model: 'other:1', executionHost: 'this-mac' };

function fixture() {
  let count = 0;
  let tick = 0;
  const options = { now: () => new Date(Date.UTC(2026, 10, 2, 10, 0, tick++)).toISOString(), id: () => id(++count) };
  let state = createDemoState(options);
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Invented question about [the] plan.' }, options);
  state = applyCommand(state, { type: 'send-demo', sessionId }, options);
  state = applyCommand(state, { type: 'set-participant-choice', sessionId, participant: local }, options);
  const reply = state.messages.filter((message) => message.sessionId === sessionId).at(-1)!;
  const mine = state.messages.filter((message) => message.sessionId === sessionId && message.role === 'user').at(-1)!;
  return { state, options, sessionId, reply, mine };
}

test('sharing is off until turned on, and needs a participant', () => {
  const f = fixture();
  assert.equal(reactionSharingOn(f.state.sessions[0]), false);
  const reacted = applyCommand(f.state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  assert.equal(reacted.drafts[f.sessionId], '', 'no note while sharing is off');
  const bare = applyCommand(createDemoState(f.options), { type: 'create-session', goalId: null }, f.options);
  assert.throws(() => applyCommand(bare, { type: 'set-reaction-sharing', sessionId: bare.sessions.at(-1)!.id, on: true }, f.options),
    (error) => error instanceof DomainError && error.message === 'Choose a participant for this chat before sharing reactions.');
});

test('with sharing on, reactions write a visible note at the top of the draft that follows them', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  assert.equal(reactionSharingOn(state.sessions[0]), true);
  state = applyCommand(state, { type: 'set-draft', sessionId: f.sessionId, text: 'My next words.' }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'question' }, f.options);
  const first = state.drafts[f.sessionId];
  assert.match(first, /^\[My reactions: ❓ on your reply "[^"]+"\]\n\nMy next words\.$/);
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.mine.id, emoji: '🦊' }, f.options);
  const second = splitReactionsNote(state.drafts[f.sessionId])!;
  assert.ok(second.note.includes('❓ on your reply'));
  assert.ok(second.note.includes('🦊 on my message "Invented question about (the) plan."'), 'brackets in a snippet never end the note');
  assert.equal(second.rest, 'My next words.');
  // A rating changes nothing in the note.
  const rated = applyCommand(state, { type: 'set-message-rating', messageId: f.reply.id, rating: 'up' }, f.options);
  assert.equal(rated.drafts[f.sessionId], state.drafts[f.sessionId]);
  // Taking every reaction off removes the note.
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'question' }, f.options);
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.mine.id, emoji: '🦊' }, f.options);
  assert.equal(state.drafts[f.sessionId], 'My next words.');
  assert.equal(validateState(state).valid, true);
});

test('each reaction is shared once, even when another one on the same message changes later', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  assert.match(state.drafts[f.sessionId], /^\[My reactions: ❤️ on your reply/);
  assert.equal(validateState(state).valid, true, 'a pending reaction saves');
  state = applyCommand(state, { type: 'send-demo', sessionId: f.sessionId }, f.options);
  assert.equal(state.drafts[f.sessionId], '');
  // The heart was shared with that Send; adding the idea lists only the idea.
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'idea' }, f.options);
  assert.match(state.drafts[f.sessionId], /^\[My reactions: 💡 on your reply "[^"]+"\]\n\n$/);
  // Picking a quick emoji from the full set is the same reaction.
  state = applyCommand(state, { type: 'toggle-message-emoji', messageId: f.reply.id, emoji: '💡' }, f.options);
  assert.equal(state.drafts[f.sessionId], '');
  assert.equal(state.sessions[0].reactionSharing?.added, undefined, 'nothing pending is kept');
  assert.equal(validateState(state).valid, true);
});

test('a Reply quote above the note leaves it followed, and Off still removes it', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  const quoted = draftWithReplyQuote(state.drafts[f.sessionId], 'Invented quoted line');
  state = applyCommand(state, { type: 'set-draft', sessionId: f.sessionId, text: `${quoted}My words.` }, f.options);
  assert.equal(reactionsNoteEdited(state.sessions[0], state.drafts[f.sessionId]), false, 'a quote above is not an edit');
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'idea' }, f.options);
  const split = splitReactionsNote(state.drafts[f.sessionId])!;
  assert.equal(split.before, '> Invented quoted line\n\n');
  assert.ok(split.note.includes('❤️ 💡 on your reply'));
  assert.equal(split.after, 'My words.');
  const off = applyCommand(state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: false }, f.options);
  assert.equal(off.drafts[f.sessionId], '> Invented quoted line\n\nMy words.');
  assert.equal(reactionsNoteSendHold(off.sessions[0], off.drafts[f.sessionId]), undefined);
});

test('once he edits the note the Desk stops changing it, and says so', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  const edited = state.drafts[f.sessionId].replace('your reply', 'your helpful reply');
  state = applyCommand(state, { type: 'set-draft', sessionId: f.sessionId, text: edited }, f.options);
  assert.equal(reactionsNoteEdited(state.sessions[0], state.drafts[f.sessionId]), true);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'idea' }, f.options);
  assert.equal(state.drafts[f.sessionId], edited);
});

test('off means off: turning sharing off removes the note, edited or not, and a broken note holds Send', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  const edited = `${state.drafts[f.sessionId].replace('your reply', 'that reply')}Keep this.`;
  state = applyCommand(state, { type: 'set-draft', sessionId: f.sessionId, text: edited }, f.options);
  const off = applyCommand(state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: false }, f.options);
  assert.equal(off.drafts[f.sessionId], 'Keep this.');
  assert.equal(off.sessions[0].reactionSharing, undefined);
  assert.equal(reactionsNoteSendHold(off.sessions[0], off.drafts[f.sessionId]), undefined);
  // Edits to the start of the note, or a line break inside it, still let Off remove it.
  for (const text of ['[My reactions:❤️ on that reply]\n\nKeep this.', '[My reactions: ❤️ on\nthat reply]\n\nKeep this.']) {
    const changed = applyCommand(state, { type: 'set-draft', sessionId: f.sessionId, text }, f.options);
    const changedOff = applyCommand(changed, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: false }, f.options);
    assert.equal(changedOff.drafts[f.sessionId], 'Keep this.', text);
  }
  // A note whose closing bracket was deleted can't be found whole: Send is held.
  const broken = applyCommand(state, { type: 'set-draft', sessionId: f.sessionId, text: '[My reactions: ❤️ on your reply\nKeep this' }, f.options);
  const brokenOff = applyCommand(broken, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: false }, f.options);
  assert.equal(reactionsNoteSendHold(brokenOff.sessions[0], brokenOff.drafts[f.sessionId]),
    'This draft still has a reactions note. Delete it or turn sharing back on.');
});

test('changing the participant turns sharing off and removes the note', () => {
  const f = fixture();
  let state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  state = applyCommand(state, { type: 'toggle-message-reaction', messageId: f.reply.id, reaction: 'heart' }, f.options);
  state = applyCommand(state, { type: 'set-participant-choice', sessionId: f.sessionId, participant: other }, f.options);
  assert.equal(state.sessions[0].reactionSharing, undefined);
  assert.equal(reactionSharingOn(state.sessions[0]), false);
  assert.equal(state.drafts[f.sessionId], '');
  assert.equal(validateState(state).valid, true);
});

test('earlier turns holding a note stay out of the context unless sharing is on for this participant', () => {
  const f = fixture();
  const session = { ...f.state.sessions[0] };
  const run = (runId: string, input: string) => ({ runId, sessionId: f.sessionId, phase: 'completed', inputChunks: [input], outputChunks: ['ok'] }) as unknown as ConversationRun;
  const runs = [run('a', 'plain'), run('b', '[My reactions: ❤️ on your reply "x"]\n\nmore'), run('c', 'plain again')];
  assert.deepEqual(contextRunsFor(runs, session).map((item) => item.runId), ['a', 'c']);
  const all = new Set(['a', 'b', 'c']);
  assert.equal(reactionsLine(runs, session, 'Invented local model on this Mac', all),
    '1 earlier turn with reactions you shared is left out, because sharing is off for Invented local model.');
  // A turn the context limit would leave out anyway isn't counted.
  assert.equal(reactionsLine(runs, session, 'Invented local model on this Mac', new Set(['c'])), undefined);
  const sharing = { ...session, reactionSharing: { participant: { ...local }, since: session.updatedAt } };
  assert.deepEqual(contextRunsFor(runs, sharing).map((item) => item.runId), ['a', 'b', 'c']);
  assert.equal(reactionsLine(runs, sharing, 'Invented local model on this Mac', all),
    'Your reactions in this chat go to Invented local model on this Mac with your next message.');
});

test('a saved switch that is malformed is refused, not repaired', () => {
  const f = fixture();
  const state = applyCommand(f.state, { type: 'set-reaction-sharing', sessionId: f.sessionId, on: true }, f.options);
  for (const bad of [
    { participant: local },
    { participant: { id: 'x' }, since: state.sessions[0].updatedAt },
    { participant: local, since: 'yesterday' },
    { participant: local, since: state.sessions[0].updatedAt, note: 'not a note' },
    { participant: local, since: state.sessions[0].updatedAt, extra: true },
    { participant: local, since: state.sessions[0].updatedAt, added: [] },
    { participant: local, since: state.sessions[0].updatedAt, added: [{ messageId: 'x', emoji: '❤️' }] },
    { participant: local, since: state.sessions[0].updatedAt, added: [{ messageId: 'x', emoji: '❤️', at: '2020-01-01T00:00:00.000Z' }] },
  ]) {
    const broken = structuredClone(state);
    (broken.sessions[0] as unknown as Record<string, unknown>).reactionSharing = bad;
    assert.equal(validateState(broken).valid, false, JSON.stringify(bad));
  }
});
