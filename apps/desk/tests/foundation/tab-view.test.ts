import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserTabView, DESK_TAB_VIEW_KEY } from '../../src/adapters/browser-tab-view';
import { applyCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';

test('stale or damaged tab choices cannot make a valid saved workspace unopenable', () => {
  const state = createDemoState();
  const other = applyCommand(state, { type: 'create-goal', title: 'Another invented goal' });
  const cases = [
    '{broken tab choices',
    JSON.stringify({ schemaVersion: 2, selection: state.selection, preferences: state.preferences }),
    JSON.stringify({ schemaVersion: 1, selection: { ...state.selection, sessionId: '00000000-0000-4000-8000-999999999999' }, preferences: state.preferences }),
    JSON.stringify({ schemaVersion: 1, selection: { ...state.selection, sessionId: null, goalId: '00000000-0000-4000-8000-999999999999' }, preferences: state.preferences }),
    JSON.stringify({ schemaVersion: 1, selection: state.selection, preferences: { theme: 'unknown' } }),
  ];
  for (const raw of cases) {
    const tab = new BrowserTabView({ getItem: () => raw, setItem: () => { throw new Error('Should not repair stored choices while reading'); } });
    const restored = tab.load(other);
    assert.equal(restored.state, other);
    assert.ok(restored.warning);
    assert.deepEqual(restored.state.drafts, other.drafts);
  }
});

test('a cached session follows its authoritative folder after another tab refiles it without warning or cache writes', () => {
  const first = createDemoState();
  const sessionId = first.selection.sessionId!;
  const viewed = applyCommand(first, { type: 'set-theme', theme: 'dark' });
  const raw = JSON.stringify({ schemaVersion: 1, selection: viewed.selection, preferences: viewed.preferences });
  const second = applyCommand(first, { type: 'create-goal', title: 'Invented destination', empty: true });
  const moved = applyCommand(second, { type: 'move-session', sessionId, goalId: second.selection.goalId });
  const before = JSON.stringify(moved);
  const tab = new BrowserTabView({ getItem: () => raw, setItem: () => { throw new Error('A view read must not save'); } });
  const restored = tab.load(moved);
  assert.equal(restored.warning, null);
  assert.equal(restored.state.selection.sessionId, sessionId);
  assert.equal(restored.state.selection.goalId, second.selection.goalId);
  assert.equal(restored.state.preferences.theme, 'dark');
  assert.equal(restored.state.revision, moved.revision);
  assert.deepEqual(restored.state.sessions, moved.sessions);
  assert.deepEqual(restored.state.drafts, moved.drafts);
  assert.equal(JSON.stringify(moved), before);
});

test('reopening a tab restores its view over newer shared work without replacing that work', () => {
  const first = createDemoState();
  const viewed = applyCommand(first, { type: 'navigate', route: 'work' });
  const chosen = applyCommand(viewed, { type: 'set-theme', theme: 'dark' });
  const cache = new Map<string, string>();
  const tab = new BrowserTabView({ getItem: (key) => cache.get(key) ?? null, setItem: (key, raw) => { cache.set(key, raw); } });
  assert.equal(tab.save(chosen), null);
  const newer = applyCommand(first, { type: 'set-draft', sessionId: first.selection.sessionId!, text: 'Newer invented work saved in another tab' });
  const restored = tab.load(newer);
  assert.equal(restored.warning, null);
  assert.equal(restored.state.selection.route, 'work');
  assert.equal(restored.state.preferences.theme, 'dark');
  assert.equal(restored.state.revision, newer.revision);
  assert.equal(restored.state.drafts[first.selection.sessionId!], 'Newer invented work saved in another tab');
  assert.deepEqual([...cache.keys()], [DESK_TAB_VIEW_KEY]);
});
