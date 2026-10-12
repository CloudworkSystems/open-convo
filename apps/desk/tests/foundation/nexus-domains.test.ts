import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, DomainError, isViewCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { validateState } from '../../src/domain/validation';

test('earlier workspace fields load exactly, without inventing folders, moving sessions or replacing drafts', () => {
  const legacy = createDemoState();
  legacy.drafts[legacy.sessions[0].id] = 'Invented draft from the earlier preview';
  assert.equal(Object.hasOwn(legacy.goals[0], 'parentId'), false);
  const raw = JSON.stringify(legacy);
  const result = validateState(JSON.parse(raw));
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(JSON.stringify(result.state), raw);
});

test('empty nested domains retain their parent and can be selected before a session exists', () => {
  const original = createDemoState();
  const folder = applyCommand(original, { type: 'create-goal', title: 'Invented research', parentId: original.goals[0].id, empty: true });
  assert.equal(folder.sessions.length, original.sessions.length);
  assert.equal(folder.selection.sessionId, null);
  assert.equal(folder.goals.at(-1)?.parentId, original.goals[0].id);
  assert.deepEqual(folder.drafts, original.drafts);
  assert.equal(validateState(folder).valid, true);
  const selected = applyCommand(folder, { type: 'select-goal', goalId: folder.goals.at(-1)!.id });
  assert.equal(selected.revision, folder.revision);
  assert.equal(selected.selection.sessionId, null);
  const withSession = applyCommand(selected, { type: 'create-session', goalId: selected.selection.goalId });
  assert.equal(withSession.sessions.at(-1)?.goalId, folder.goals.at(-1)?.id);
  assert.equal(validateState(withSession).valid, true);
});

test('unassigned sessions accept demo replies and refile without losing messages, drafts or historical activity', () => {
  const original = createDemoState();
  let state = applyCommand(original, { type: 'create-session', goalId: null });
  const sessionId = state.sessions.at(-1)!.id;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Invented unassigned message' });
  state = applyCommand(state, { type: 'send-demo', sessionId });
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Invented unfinished follow-up' });
  const messages = structuredClone(state.messages);
  const activity = structuredClone(state.activity);
  const drafts = structuredClone(state.drafts);
  const filed = applyCommand(state, { type: 'move-session', sessionId, goalId: original.goals[0].id });
  assert.equal(filed.revision, state.revision + 1);
  assert.deepEqual(filed.messages, messages);
  assert.deepEqual(filed.drafts, drafts);
  assert.deepEqual(filed.activity.slice(0, activity.length), activity);
  assert.equal(filed.selection.goalId, original.goals[0].id);
  assert.equal(validateState(filed).valid, true);
  const returned = applyCommand(filed, { type: 'move-session', sessionId, goalId: null });
  assert.equal(returned.selection.goalId, null);
  assert.equal(validateState(returned).valid, true);
  assert.deepEqual(returned.messages, messages);
  assert.deepEqual(returned.drafts, drafts);
  assert.throws(() => applyCommand(state, { type: 'move-session', sessionId, goalId: crypto.randomUUID() }));
  assert.deepEqual(state.messages, messages);
});

test('hierarchy cycles, missing parents and unknown view values remain rejected without repair', () => {
  const original = createDemoState();
  const child = applyCommand(original, { type: 'create-goal', title: 'Invented child', parentId: original.goals[0].id, empty: true });
  const cyclic = structuredClone(child); cyclic.goals[0].parentId = cyclic.goals[1].id;
  const missing = structuredClone(child); missing.goals[1].parentId = crypto.randomUUID();
  const badView = { ...child, preferences: { theme: 'system', nexusView: 'unknown' } };
  for (const state of [cyclic, missing, badView]) {
    const before = JSON.stringify(state);
    assert.equal(validateState(state).valid, false);
    assert.equal(JSON.stringify(state), before);
  }
});

test('Nexus mode changes are per-tab views and do not modify content or its revision', () => {
  const original = createDemoState();
  let state = original;
  for (const view of ['canvas', 'atlas', 'roadmap', 'navigator'] as const) {
    state = applyCommand(state, { type: 'set-nexus-view', view });
    assert.equal(state.preferences.nexusView, view);
    assert.equal(state.revision, original.revision);
    assert.equal(state.updatedAt, original.updatedAt);
    assert.deepEqual(state.messages, original.messages);
    assert.deepEqual(state.sessions, original.sessions);
    assert.deepEqual(state.drafts, original.drafts);
    assert.equal(validateState(state).valid, true);
  }
});

test('renaming a nested domain changes its title while retaining hierarchy, work and the current view', () => {
  const options = { now: () => '2026-10-03T16:30:00.000Z' };
  const original = createDemoState(options);
  const rootId = original.goals[0].id;
  let state = applyCommand(original, { type: 'create-goal', title: 'Invented child', parentId: rootId }, options);
  const domainId = state.selection.goalId!;
  const sessionId = state.selection.sessionId!;
  state = applyCommand(state, { type: 'set-draft', sessionId, text: 'Keep this invented session draft' }, options);
  state = applyCommand(state, { type: 'set-goal-draft', goalId: domainId, field: 'nextStep', value: 'Keep this pending next step' }, options);
  state = applyCommand(state, { type: 'set-goal-draft', goalId: domainId, field: 'workTitle', value: 'Keep this pending work title' }, options);
  state = applyCommand(state, { type: 'create-goal', title: 'Invented grandchild', parentId: domainId, empty: true }, options);
  state = applyCommand(state, { type: 'select-session', sessionId: original.sessions[0].id }, options);
  state = applyCommand(state, { type: 'set-nexus-view', view: 'atlas' }, options);
  state = applyCommand(state, { type: 'navigate', route: 'work' }, options);
  const before = JSON.stringify(state);
  const target = state.goals.find((value) => value.id === domainId)!;
  const now = '2026-10-05T16:30:00.000Z';
  const eventId = '00000000-0000-4000-8000-999999999999';
  const command = { type: 'rename-domain', domainId, title: '  Renamed invented domain \n' } as const;
  assert.equal(isViewCommand(command), false);
  const renamed = applyCommand(state, command, { now: () => now, id: () => eventId });
  assert.deepEqual(renamed.goals.find((value) => value.id === domainId), { ...target, title: 'Renamed invented domain', updatedAt: now });
  assert.deepEqual(renamed.goals.filter((value) => value.id !== domainId), state.goals.filter((value) => value.id !== domainId));
  assert.deepEqual(renamed.sessions, state.sessions);
  assert.deepEqual(renamed.messages, state.messages);
  assert.deepEqual(renamed.drafts, state.drafts);
  assert.deepEqual(renamed.goalDrafts, state.goalDrafts);
  assert.deepEqual(renamed.workItems, state.workItems);
  assert.deepEqual(renamed.notes, state.notes);
  assert.deepEqual(renamed.selection, state.selection);
  assert.deepEqual(renamed.preferences, state.preferences);
  assert.deepEqual(renamed.activity.slice(0, state.activity.length), state.activity);
  assert.equal(renamed.activity.length, state.activity.length + 1);
  assert.deepEqual(renamed.activity.at(-1), { id: eventId, kind: 'edited', summary: 'Domain renamed.', goalId: domainId, sessionId: null, createdAt: now });
  assert.equal(renamed.revision, state.revision + 1);
  assert.equal(renamed.updatedAt, now);
  assert.equal(validateState(renamed).valid, true);
  assert.equal(JSON.stringify(state), before);
});

test('an unchanged trimmed domain name returns the original state without recording an edit', () => {
  const state = createDemoState();
  const target = state.goals[0];
  for (const title of [target.title, ` \n${target.title}\t `]) {
    assert.equal(applyCommand(state, { type: 'rename-domain', domainId: target.id, title }, {
      now: () => '2027-10-05T16:30:00.000Z',
      id: () => { throw new Error('An unchanged name must not create an activity ID.'); },
    }), state);
  }
});

test('domain renames reject empty names, names beyond 180 characters and missing domains without changing work', () => {
  const state = createDemoState();
  const domainId = state.goals[0].id;
  const before = JSON.stringify(state);
  for (const title of ['', ' \n\t ', ` ${'x'.repeat(181)} `]) {
    assert.throws(() => applyCommand(state, { type: 'rename-domain', domainId, title }), DomainError);
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => applyCommand(state, {
    type: 'rename-domain', domainId: '00000000-0000-4000-8000-999999999999', title: 'Missing invented domain',
  }), { name: 'DomainError', message: 'The goal no longer exists. Your attempted edit has not been applied.' });
  assert.equal(JSON.stringify(state), before);
  const boundary = applyCommand(state, { type: 'rename-domain', domainId, title: ` \n${'x'.repeat(180)}\t ` });
  assert.equal(boundary.goals[0].title, 'x'.repeat(180));
  assert.equal(validateState(boundary).valid, true);
});

test('selecting a session from a module, Canvas or Atlas opens its owning domain in the navigator without changing content', () => {
  const original = createDemoState();
  const state = applyCommand(original, { type: 'create-goal', title: 'Another invented domain' });
  for (const [route, view] of [['work', 'navigator'], ['memory', 'navigator'], ['data', 'navigator'], ['sessions', 'canvas'], ['sessions', 'atlas']] as const) {
    const viewed = applyCommand(applyCommand(state, { type: 'set-nexus-view', view }), { type: 'navigate', route });
    const selected = applyCommand(viewed, { type: 'select-session', sessionId: original.sessions[0].id });
    assert.deepEqual(selected.selection, { goalId: original.goals[0].id, sessionId: original.sessions[0].id, route: 'sessions' });
    assert.equal(selected.preferences.nexusView, 'navigator');
    assert.equal(selected.revision, state.revision);
    assert.equal(selected.updatedAt, state.updatedAt);
    assert.deepEqual(selected.goals, state.goals);
    assert.deepEqual(selected.sessions, state.sessions);
    assert.deepEqual(selected.messages, state.messages);
    assert.deepEqual(selected.drafts, state.drafts);
    assert.deepEqual(selected.activity, state.activity);
    assert.equal(validateState(selected).valid, true);
  }
});
