import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository, DESK_STORAGE_KEY, type StorageLike } from '../../src/adapters/browser-repository';
import { applyCommand, DomainError, isViewCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { defaultSessionTitle, SESSION_CREATION_TIME_ZONE, sessionDatePrefix } from '../../src/domain/session-naming';
import { validateState } from '../../src/domain/validation';

const time = '2026-10-03T16:30:00.000Z';
const later = '2026-10-05T16:30:00.000Z';
const options = { now: () => time };

class MetadataStorage implements StorageLike {
  raw: string | null = null;
  blocked = false;
  getItem(key: string) { assert.equal(key, DESK_STORAGE_KEY); return this.raw; }
  setItem(key: string, value: string) {
    assert.equal(key, DESK_STORAGE_KEY);
    if (this.blocked) throw new Error('Blocked write');
    this.raw = value;
  }
}

test('older synthetic workspaces remain exact without pins, inferred names, intents or histories', () => {
  const state = createDemoState(options);
  const raw = JSON.stringify(state);
  const result = validateState(JSON.parse(raw));
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(JSON.stringify(result.state), raw);
  assert.equal(Object.hasOwn(state.goals[0], 'pinned'), false);
  for (const field of ['pinned', 'intent', 'intentDraft', 'intentHistory', 'titleHistory']) assert.equal(Object.hasOwn(state.sessions[0], field), false);
});

test('only new default names gain the compact creation date in America/New_York, including midnight and DST boundaries', () => {
  assert.equal(SESSION_CREATION_TIME_ZONE, 'America/New_York');
  assert.equal(sessionDatePrefix('2026-10-05T02:00:00.000Z'), '261004');
  assert.equal(sessionDatePrefix('2026-10-05T04:00:00.000Z'), '261005');
  assert.equal(sessionDatePrefix('2026-03-08T06:59:59.000Z'), '260308');
  assert.equal(sessionDatePrefix('2026-03-08T07:00:00.000Z'), '260308');
  assert.equal(defaultSessionTitle(time), '261003 New conversation');
  assert.throws(() => sessionDatePrefix('not a creation instant'), RangeError);
  const original = createDemoState(options);
  for (const goalId of [original.goals[0].id, null]) {
    const state = applyCommand(original, { type: 'create-session', goalId }, options);
    assert.equal(state.sessions.at(-1)?.title, '261003 New conversation');
    assert.deepEqual(state.sessions[0], original.sessions[0]);
  }
  const domain = applyCommand(original, { type: 'create-goal', title: 'Invented topic' }, options);
  assert.equal(domain.sessions.at(-1)?.title, '261003 New conversation');
  const named = applyCommand(original, { type: 'create-session', goalId: null, title: '  My freely chosen alias  ' }, options);
  assert.equal(named.sessions.at(-1)?.title, 'My freely chosen alias');
});

test('pins are idempotent markers, preserving order, placement, session work and other domain drafts', () => {
  let state = createDemoState(options);
  const goalId = state.goals[0].id;
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'create-session', goalId: null }, options);
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Keep the unfinished conversation' }, options);
  const before = structuredClone(state);
  let pinned = applyCommand(state, { type: 'set-domain-pinned', domainId: goalId, pinned: true }, { now: () => later });
  pinned = applyCommand(pinned, { type: 'set-session-pinned', sessionId, pinned: true }, { now: () => time });
  assert.equal(pinned.goals[0].pinned, true);
  assert.equal(pinned.sessions[0].pinned, true);
  assert.equal(pinned.sessions[0].updatedAt, later);
  assert.deepEqual(pinned.sessions.map(({ id, goalId, createdAt }) => ({ id, goalId, createdAt })), before.sessions.map(({ id, goalId, createdAt }) => ({ id, goalId, createdAt })));
  assert.deepEqual(pinned.messages, before.messages);
  assert.deepEqual(pinned.drafts, before.drafts);
  assert.deepEqual(pinned.goalDrafts, before.goalDrafts);
  assert.deepEqual(pinned.workItems, before.workItems);
  assert.deepEqual(pinned.selection, before.selection);
  assert.equal(applyCommand(pinned, { type: 'set-session-pinned', sessionId, pinned: true }, options), pinned);
  assert.equal(applyCommand(pinned, { type: 'set-domain-pinned', domainId: goalId, pinned: true }, options), pinned);
  let unpinned = applyCommand(pinned, { type: 'set-session-pinned', sessionId, pinned: false }, options);
  unpinned = applyCommand(unpinned, { type: 'set-domain-pinned', domainId: goalId, pinned: false }, options);
  assert.equal(Object.hasOwn(unpinned.sessions[0], 'pinned'), false);
  assert.equal(Object.hasOwn(unpinned.goals[0], 'pinned'), false);
  assert.equal(applyCommand(unpinned, { type: 'set-session-pinned', sessionId, pinned: false }, options), unpinned);
  assert.equal(validateState(unpinned).valid, true);
});

test('renaming preserves immutable identity and intent while retaining the previously observed name and all changed aliases', () => {
  let state = createDemoState(options);
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Preserve this message draft' }, options);
  state = applyCommand(state, { type: 'set-session-intent-draft', sessionId, text: 'Separately editable intent draft' }, options);
  const observed = state.sessions[0];
  const renamed = applyCommand(state, { type: 'rename-session', sessionId, title: '  A revised alias 🌳 ', expectedTitle: observed.title }, { now: () => later });
  assert.equal(renamed.sessions[0].id, observed.id);
  assert.equal(renamed.sessions[0].goalId, observed.goalId);
  assert.equal(renamed.sessions[0].createdAt, observed.createdAt);
  assert.equal(renamed.sessions[0].updatedAt, later);
  assert.equal(renamed.sessions[0].intentDraft, observed.intentDraft);
  assert.equal(renamed.sessions[0].intent, undefined);
  assert.equal(renamed.sessions[0].intentHistory, undefined);
  assert.deepEqual(renamed.sessions[0].titleHistory, [{ text: observed.title, createdAt: later }, { text: 'A revised alias 🌳', createdAt: later }]);
  assert.deepEqual(renamed.messages, state.messages);
  assert.deepEqual(renamed.drafts, state.drafts);
  assert.deepEqual(renamed.goals, state.goals);
  assert.deepEqual(renamed.goalDrafts, state.goalDrafts);
  assert.deepEqual(renamed.selection, state.selection);
  const again = applyCommand(renamed, { type: 'rename-session', sessionId, title: 'Changed again' }, options);
  assert.deepEqual(again.sessions[0].titleHistory?.map((entry) => entry.text), [observed.title, 'A revised alias 🌳', 'Changed again']);
  assert.equal(validateState(again).valid, true);
  assert.equal(applyCommand(again, { type: 'rename-session', sessionId, title: ' Changed again\n' }, options), again);
});

test('renaming a previously valid long legacy alias preserves its full observed value without imposing the new rename limit retroactively', () => {
  const state = createDemoState(options);
  const sessionId = state.sessions[0].id;
  state.sessions[0].title = 'An observed historical alias '.repeat(120);
  const raw = JSON.stringify(state);
  assert.equal(validateState(state).valid, true);
  const renamed = applyCommand(state, { type: 'rename-session', sessionId, title: 'A shorter alias', expectedTitle: state.sessions[0].title }, { now: () => later });
  assert.equal(renamed.sessions[0].titleHistory?.[0].text, state.sessions[0].title);
  assert.equal(validateState(renamed).valid, true);
  const again = applyCommand(renamed, { type: 'rename-session', sessionId, title: 'One more alias' }, options);
  assert.equal(again.sessions[0].titleHistory?.[0].text, state.sessions[0].title);
  assert.equal(validateState(again).valid, true);
  assert.equal(JSON.stringify(state), raw);
  assert.throws(() => applyCommand(renamed, { type: 'rename-session', sessionId, title: 'x'.repeat(181) }, options), DomainError);
});

test('user-saved intent retains its first recorded value and explicit edits or clear without rewriting session work', () => {
  let state = createDemoState(options);
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'This draft is not automatically intent' }, options);
  const original = structuredClone(state);
  state = applyCommand(state, { type: 'set-session-intent-draft', sessionId, text: '  Explore an invented concept.  ' }, options);
  state = applyCommand(state, { type: 'edit-session-intent', sessionId, intent: state.sessions[0].intentDraft!, expectedIntent: '' }, options);
  assert.equal(state.sessions[0].intent, 'Explore an invented concept.');
  assert.equal(Object.hasOwn(state.sessions[0], 'intentDraft'), false);
  state = applyCommand(state, { type: 'rename-session', sessionId, title: 'Different words, same intent' }, { now: () => later });
  assert.deepEqual(state.sessions[0].intentHistory, [{ text: 'Explore an invented concept.', createdAt: time }]);
  state = applyCommand(state, { type: 'edit-session-intent', sessionId, intent: 'Refine the same concept.', expectedIntent: 'Explore an invented concept.' }, { now: () => later });
  state = applyCommand(state, { type: 'edit-session-intent', sessionId, intent: ' \n ', expectedIntent: 'Refine the same concept.' }, options);
  assert.equal(Object.hasOwn(state.sessions[0], 'intent'), false);
  assert.deepEqual(state.sessions[0].intentHistory, [
    { text: 'Explore an invented concept.', createdAt: time },
    { text: 'Refine the same concept.', createdAt: later },
    { text: '', createdAt: later },
  ]);
  assert.deepEqual(state.messages, original.messages);
  assert.deepEqual(state.drafts, original.drafts);
  assert.deepEqual(state.workItems, original.workItems);
  assert.deepEqual(state.goalDrafts, original.goalDrafts);
  assert.equal(state.sessions[0].createdAt, original.sessions[0].createdAt);
  assert.equal(validateState(state).valid, true);
});

test('intent drafts recover separately from message drafts; stale edits and blocked saves keep the complete attempted work', async () => {
  const storage = new MetadataStorage();
  const repository = new BrowserRepository(storage, async (operation) => operation());
  let state = createDemoState(options);
  assert.equal((await repository.save(state, null)).kind, 'saved');
  const initialRevision = state.revision;
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Conversation composer draft' }, options);
  state = applyCommand(state, { type: 'set-session-intent-draft', sessionId, text: 'Intent form draft' }, options);
  state = applyCommand(state, { type: 'create-session', goalId: null }, options);
  state = applyCommand(state, { type: 'navigate', route: 'work' }, options);
  assert.equal((await repository.save(state, initialRevision)).kind, 'saved');
  const reloaded = repository.load();
  assert.equal(reloaded.kind, 'ready');
  if (reloaded.kind === 'ready') {
    assert.equal(reloaded.state.sessions.find((session) => session.id === sessionId)?.intentDraft, 'Intent form draft');
    assert.equal(reloaded.state.drafts[sessionId], 'Conversation composer draft');
  }
  const unchanged = JSON.stringify(state);
  assert.throws(() => applyCommand(state, { type: 'edit-session-intent', sessionId, intent: 'Attempted changed intent', expectedIntent: 'A different stored intent' }, options), DomainError);
  assert.equal(JSON.stringify(state), unchanged);
  const cancelled = applyCommand(state, { type: 'set-session-intent-draft', sessionId, text: null }, options);
  assert.equal(Object.hasOwn(cancelled.sessions.find((session) => session.id === sessionId)!, 'intentDraft'), false);
  assert.deepEqual(cancelled.drafts, state.drafts);
  const attempt = applyCommand(state, { type: 'edit-session-intent', sessionId, intent: 'Keep the failed attempt' }, options);
  const savedRaw = storage.raw;
  storage.blocked = true;
  const result = await repository.save(attempt, state.revision);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.attemptedState.sessions.find((session) => session.id === sessionId)?.intent, 'Keep the failed attempt');
  assert.equal(storage.raw, savedRaw);
});

test('session alias and intent limits, stale names and missing targets reject changes without dropping drafts', () => {
  const state = createDemoState(options);
  const sessionId = state.sessions[0].id;
  const before = JSON.stringify(state);
  for (const command of [
    { type: 'rename-session', sessionId, title: 'New alias', expectedTitle: 'A stale alias' },
    { type: 'rename-session', sessionId, title: ' \n ' },
    { type: 'rename-session', sessionId, title: 'x'.repeat(181) },
    { type: 'edit-session-intent', sessionId, intent: 'x'.repeat(4001) },
    { type: 'set-session-intent-draft', sessionId, text: 'x'.repeat(4001) },
    { type: 'rename-session', sessionId: '00000000-0000-4000-8000-999999999999', title: 'Missing target' },
  ] as const) {
    assert.throws(() => applyCommand(state, command, options), DomainError);
    assert.equal(JSON.stringify(state), before);
  }
  const boundary = applyCommand(applyCommand(state, { type: 'rename-session', sessionId, title: 'x'.repeat(180) }, options), { type: 'edit-session-intent', sessionId, intent: 'x'.repeat(4000) }, options);
  assert.equal(validateState(boundary).valid, true);
});

test('metadata validation rejects malformed pins, text, history ordering and mismatched latest values without repairing input', () => {
  const state = createDemoState(options);
  for (const metadata of [
    { pinned: 'yes' }, { intent: 3 }, { intentDraft: null }, { intentDraft: 'x'.repeat(4001) },
    { titleHistory: [] }, { titleHistory: [{ text: 'Wrong current alias', createdAt: time }] },
    { intentHistory: [{ text: 'Unmatched intent', createdAt: time }] },
    { intent: 'Match', intentHistory: [{ text: 'Match', createdAt: later }] },
    { intent: 'Match', intentHistory: [{ text: 'Match', createdAt: '2025-10-03T16:30:00.000Z' }] },
    { titleHistory: [{ text: '', createdAt: time }, { text: state.sessions[0].title, createdAt: time }] },
  ]) {
    const invalid = { ...state, sessions: [{ ...state.sessions[0], ...metadata }] };
    const raw = JSON.stringify(invalid);
    assert.equal(validateState(invalid).valid, false);
    assert.equal(JSON.stringify(invalid), raw);
  }
  assert.equal(validateState({ ...state, goals: [{ ...state.goals[0], pinned: 3 }] }).valid, false);
});

test('selecting the permanent Ungrouped folder changes only the tab view and creates no fake domain', () => {
  const state = createDemoState(options);
  const command = { type: 'select-ungrouped' } as const;
  assert.equal(isViewCommand(command), true);
  const selected = applyCommand(state, command, { now: () => later });
  assert.deepEqual(selected.selection, { goalId: null, sessionId: null, route: 'sessions' });
  assert.equal(selected.preferences.nexusView, 'navigator');
  assert.equal(selected.revision, state.revision);
  assert.equal(selected.updatedAt, state.updatedAt);
  assert.deepEqual(selected.goals, state.goals);
  assert.deepEqual(selected.sessions, state.sessions);
  assert.deepEqual(selected.messages, state.messages);
  assert.deepEqual(selected.drafts, state.drafts);
  assert.deepEqual(selected.goalDrafts, state.goalDrafts);
  assert.equal(validateState(selected).valid, true);
});

test('selecting a populated domain shows that folder without selecting a session or changing saved work', () => {
  let state = createDemoState(options);
  const goalId = state.goals[0].id;
  const sessionId = state.sessions[0].id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Keep this pending conversation draft' }, options);
  state = applyCommand(state, { type: 'set-session-intent-draft', sessionId, text: 'Keep this separate intent draft' }, options);
  state = applyCommand(state, { type: 'navigate', route: 'sessions' }, options);
  const command = { type: 'select-goal', goalId } as const;
  assert.equal(isViewCommand(command), true);
  const selected = applyCommand(state, command, { now: () => later });
  assert.deepEqual(selected.selection, { goalId, sessionId: null, route: 'sessions' });
  assert.equal(selected.revision, state.revision);
  assert.equal(selected.updatedAt, state.updatedAt);
  assert.deepEqual(selected.goals, state.goals);
  assert.deepEqual(selected.sessions, state.sessions);
  assert.deepEqual(selected.messages, state.messages);
  assert.deepEqual(selected.drafts, state.drafts);
  assert.deepEqual(selected.goalDrafts, state.goalDrafts);
  assert.deepEqual(selected.workItems, state.workItems);
  assert.deepEqual(selected.activity, state.activity);
  assert.equal(validateState(selected).valid, true);
  const sessionSelected = applyCommand(selected, { type: 'select-session', sessionId }, options);
  assert.deepEqual(sessionSelected.selection, { goalId, sessionId, route: 'sessions' });
  assert.equal(sessionSelected.revision, state.revision);
});
