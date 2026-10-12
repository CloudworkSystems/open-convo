import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { register } from 'tsx/esm/api';

// Use one module graph so the view and its provider share the same context.
const unregister = register();
const { buildCanvasScene, Canvas, Atlas } = await import('../../src/features/NexusViews.tsx');
const { createDemoState } = await import('../../src/domain/demo.ts');
const { DeskRuntimeContext, createBrowserRuntime } = await import('../../src/app/runtime.tsx');
unregister();
const now = '2026-10-05T00:00:00.000Z';

function sampleState() {
  let sequence = 0;
  const state = createDemoState({ now: () => now, id: () => `invented-${sequence++}` });
  state.goals = [
    { id: 'parent', title: 'Invented parent', nextStep: 'Try one small idea.', createdAt: now, updatedAt: now },
    { id: 'child', parentId: 'parent', title: 'Invented empty child', nextStep: '', createdAt: now, updatedAt: now },
  ];
  state.sessions = [
    // Distinct record types can have the same ID without merging their nodes.
    { id: 'parent', goalId: 'parent', title: 'Invented session', createdAt: now, updatedAt: now },
    { id: 'unassigned', goalId: null, title: 'Invented unassigned session', createdAt: now, updatedAt: now },
  ];
  state.workItems = [{ id: 'work', goalId: 'parent', title: 'Invented worksheet', status: 'returned', createdAt: now }];
  state.notes = [{ id: 'note', goalId: 'parent', body: 'An idea: <img src=x onerror=alert(1)>', createdAt: now }];
  state.selection = { route: 'sessions', goalId: 'parent', sessionId: 'parent' };
  return state;
}

test('Canvas keeps recorded parent and domain links, empty folders and unassigned session identities', () => {
  const state = sampleState();
  const before = JSON.stringify(state);
  const scene = buildCanvasScene(state);
  assert.equal(JSON.stringify(state), before, 'Building a view changed saved records.');
  assert.equal(scene.nodes.length, 7);
  assert.equal(new Set(scene.nodes.map((node) => node.id)).size, 7);
  assert.deepEqual(scene.links.map(({ source, target, kind }) => [source, target, kind]).sort(), [
    ['domain:parent', 'domain:child', 'inside'],
    ['domain:parent', 'next-step:parent', 'belongs-to'],
    ['domain:parent', 'note:note', 'belongs-to'],
    ['domain:parent', 'session:parent', 'belongs-to'],
    ['domain:parent', 'work:work', 'belongs-to'],
  ].sort());
  assert.ok(scene.nodes.some((node) => node.id === 'domain:child' && node.recordId === 'child'));
  assert.ok(scene.nodes.some((node) => node.id === 'session:unassigned' && node.recordId === 'unassigned'));
  assert.equal(scene.links.some((link) => link.target === 'session:unassigned'), false, 'An unassigned session acquired an inferred folder link.');
  assert.equal(scene.nodes.find((node) => node.id === 'work:work').status, 'returned');
  const nodeIds = new Set(scene.nodes.map((node) => node.id));
  assert.ok(scene.links.every((link) => nodeIds.has(link.source) && nodeIds.has(link.target)));
});

test('Canvas renders existing records as HTML while Atlas clearly reserves the planned 3D wiki and RAG view', () => {
  const state = sampleState();
  const props = { state, onDomain: () => {}, onSession: () => {} };
  const runtime = createBrowserRuntime();
  const canvas = renderToStaticMarkup(createElement(DeskRuntimeContext.Provider, { value: runtime }, createElement(Canvas, props)));
  assert.match(canvas, /data-node-id="session:parent"/);
  assert.match(canvas, /data-record-id="parent"[^>]+data-node-kind="session"/);
  assert.match(canvas, /aria-label="Open session Invented session"/);
  assert.match(canvas, /aria-label="Open folder Invented parent"/);
  assert.match(canvas, /data-record-id="work"/);
  assert.match(canvas, /An idea: &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(canvas, /<img/);
  const atlas = renderToStaticMarkup(createElement(DeskRuntimeContext.Provider, { value: runtime }, createElement(Atlas, props)));
  assert.match(atlas, /Planned · not connected/);
  assert.match(atlas, /3D knowledge graph/);
  assert.match(atlas, /Karpathy-style LLM wiki/);
  assert.match(atlas, /graph retrieval \(RAG\)/);
  assert.doesNotMatch(atlas, /<svg[^>]+Recorded workspace relationships|Open session|<foreignObject/);
  runtime.revoke();
});
