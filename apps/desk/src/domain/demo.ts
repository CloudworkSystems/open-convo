import type { DeskState, DomainOptions } from './types';

export function domainClock(options: DomainOptions = {}): { now: string; id: () => string } {
  return {
    now: options.now?.() ?? new Date().toISOString(),
    id: options.id ?? (() => crypto.randomUUID()),
  };
}

export function createDemoState(options: DomainOptions = {}): DeskState {
  const { now, id } = domainClock(options);
  const goalId = id();
  const sessionId = id();
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: now,
    goals: [{ id: goalId, title: 'Shape a useful idea', nextStep: 'Choose one small outcome to try.', createdAt: now, updatedAt: now }],
    sessions: [{ id: sessionId, goalId, title: 'A place to begin', createdAt: now, updatedAt: now }],
    messages: [{ id: id(), sessionId, role: 'assistant', body: 'This is an invented-data preview. Start with a small goal, keep a draft, and try a simulated reply. No AI provider is connected.', status: 'complete', provenance: 'simulation', createdAt: now }],
    drafts: { [sessionId]: '' },
    goalDrafts: { [goalId]: { nextStep: null, workTitle: '' } },
    workItems: [{ id: id(), goalId, title: 'Outline one useful worksheet', status: 'planned', createdAt: now }],
    notes: [{ id: id(), goalId, body: 'Invented example: keep the first useful step small enough to try.', createdAt: now }],
    activity: [{ id: id(), goalId, sessionId, kind: 'created', summary: 'Invented workspace created.', createdAt: now }],
    selection: { goalId, sessionId, route: 'setup' },
    preferences: { theme: 'system' },
    capabilities: { mode: 'synthetic', provider: 'demo-only', native: 'unavailable' },
  };
}

export function demoResponse(text: string, goalTitle: string): string {
  return `Simulated reply — no model call.\n\nFor “${goalTitle}”, choose one small outcome, write down what success looks like, and try it.\n\nYour draft was: ${text}`;
}
