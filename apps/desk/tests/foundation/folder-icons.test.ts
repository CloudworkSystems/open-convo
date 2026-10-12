import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommand, DomainError } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';
import { folderIconChoices } from '../../src/domain/folder-icons';
import type { DeskCommand } from '../../src/domain/types';
import { validateState } from '../../src/domain/validation';

const clock = { now: () => '2026-10-05T16:30:00.000Z' };

test('folder icons retain old records exactly and change only the chosen folder marker', () => {
  let state = createDemoState(clock);
  state = applyCommand(state, { type: 'set-draft', sessionId: state.sessions[0].id, text: 'Keep unfinished session work' }, clock);
  const raw = JSON.stringify(state);
  const loaded = validateState(JSON.parse(raw));
  assert.equal(loaded.valid, true);
  if (loaded.valid) assert.equal(JSON.stringify(loaded.state), raw);
  assert.equal(Object.hasOwn(state.goals[0], 'icon'), false);
  const id = state.goals[0].id;
  for (const { value } of folderIconChoices) {
    const next = applyCommand(state, { type: 'set-folder-icon', domainId: id, icon: value }, clock);
    assert.equal(validateState(next).valid, true);
    assert.equal(next.goals[0].icon ?? 'default', value);
    assert.equal(next.goals[0].id, id);
    for (const field of ['sessions', 'messages', 'drafts', 'goalDrafts', 'notes', 'workItems', 'selection'] as const) assert.deepEqual(next[field], state[field]);
    assert.equal(applyCommand(next, { type: 'set-folder-icon', domainId: id, icon: value }, clock), next);
    state = next;
  }
  const cleared = applyCommand(state, { type: 'set-folder-icon', domainId: id, icon: 'default' }, clock);
  assert.equal(Object.hasOwn(cleared.goals[0], 'icon'), false);
  assert.equal(validateState(cleared).valid, true);
});

test('unknown icon values fail without repair or changing any saved work', () => {
  const state = createDemoState(clock);
  const original = JSON.stringify(state);
  for (const icon of ['unknown', '', 'https://example.invalid/icon.svg', null, 42]) {
    const malformed = structuredClone(state) as unknown as { goals: { icon: unknown }[] };
    malformed.goals[0].icon = icon;
    const before = JSON.stringify(malformed);
    assert.equal(validateState(malformed).valid, false);
    assert.equal(JSON.stringify(malformed), before);
    assert.throws(() => applyCommand(state, { type: 'set-folder-icon', domainId: state.goals[0].id, icon } as DeskCommand, clock), DomainError);
    assert.equal(JSON.stringify(state), original);
  }
});

test('new Suggested work clears only its own title draft and preserves earlier placements and stable records', () => {
  let state = createDemoState(clock);
  const goalId = state.goals[0].id;
  state = applyCommand(state, { type: 'set-goal-draft', goalId, field: 'workTitle', value: 'An idea for discussion' }, clock);
  const next = applyCommand(state, { type: 'add-work', goalId, title: 'An idea for discussion', roadmapColumn: 'suggested' }, clock);
  assert.equal(next.workItems.at(-1)?.roadmapColumn, 'suggested');
  assert.equal(next.workItems.at(-1)?.status, 'planned');
  assert.deepEqual(next.workItems.slice(0, state.workItems.length), state.workItems);
  assert.equal(next.goalDrafts[goalId].workTitle, '');
  for (const field of ['sessions', 'messages', 'drafts', 'notes', 'selection'] as const) assert.deepEqual(next[field], state[field]);
  assert.equal(validateState(next).valid, true);
  const corrupted = structuredClone(next) as unknown as { workItems: { roadmapColumn: string }[] };
  corrupted.workItems.at(-1)!.roadmapColumn = 'not-a-column';
  assert.equal(validateState(corrupted).valid, false);
});
