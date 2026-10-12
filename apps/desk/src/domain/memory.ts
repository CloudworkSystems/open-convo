import type { DeskState, MemoryCommand, MemoryDraft, MemoryEntry, MemorySource, MemoryUse, MemoryValue } from './types';

const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MEMORY_TEXT_LIMIT = 4000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && identity.test(value);
const body = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MEMORY_TEXT_LIMIT;
const draftBody = (value: unknown): value is string => typeof value === 'string' && value.length <= MEMORY_TEXT_LIMIT;
const use = (value: unknown): value is MemoryUse => value === 'active' || value === 'view-only' || value === 'trashed';
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameSource = (left: MemorySource, right: MemorySource) => left.kind === right.kind && (left.kind === 'direct' || right.kind !== 'direct' && left.id === right.id);
const sameValue = (left: MemoryValue, right: MemoryValue) => left.body === right.body && left.use === right.use;
const value = (entry: MemoryValue): MemoryValue => ({ body: entry.body, use: entry.use });

export class MemoryError extends Error {}
function refuse(message: string): never { throw new MemoryError(message); }

export function isMemoryCommand(command: { type: string }): command is MemoryCommand {
  return ['set-memory-draft', 'set-memory-correction-draft', 'remember-memory', 'correct-memory', 'forget-memory', 'restore-memory', 'undo-memory'].includes(command.type);
}

function validSource(source: unknown, messageIds: Set<string>, noteIds: Set<string>): source is MemorySource {
  if (!record(source)) return false;
  return source.kind === 'direct' ? keys(source, ['kind'])
    : keys(source, ['kind', 'id']) && id(source.id) && (source.kind === 'message' ? messageIds.has(source.id) : source.kind === 'note' && noteIds.has(source.id));
}

/** Validate in full without migration, normalization or dropping unknown data. */
export function validateMemoryFields(input: Record<string, unknown>, goalIds: Set<string>, messageIds: Set<string>, noteIds: Set<string>, addId: (value: unknown) => boolean): boolean {
  if (Object.hasOwn(input, 'memories')) {
    if (!Array.isArray(input.memories)) return false;
    for (const entry of input.memories) {
      if (!record(entry) || !keys(entry, ['id', 'goalId', 'source', 'revision', 'body', 'use', 'createdAt', 'updatedAt', 'history', 'undo'], ['correctionDraft'])
        || !addId(entry.id) || !id(entry.goalId) || !goalIds.has(entry.goalId) || !validSource(entry.source, messageIds, noteIds)
        || !Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1 || !body(entry.body) || !use(entry.use)
        || !time(entry.createdAt) || !time(entry.updatedAt) || entry.updatedAt < entry.createdAt
        || !(entry.correctionDraft === undefined || draftBody(entry.correctionDraft)) || !Array.isArray(entry.history) || entry.history.length !== entry.revision) return false;
      let previousTime = entry.createdAt;
      for (const [index, change] of entry.history.entries()) {
        if (!record(change) || !keys(change, ['revision', 'operation', 'body', 'use', 'changedAt']) || change.revision !== index + 1
          || !body(change.body) || !use(change.use) || !time(change.changedAt) || change.changedAt < previousTime || change.changedAt > entry.updatedAt
          || (index === 0 ? change.operation !== 'remember' || change.use !== 'active' || change.changedAt !== entry.createdAt
            : typeof change.operation !== 'string' || !['correct', 'forget', 'restore', 'undo'].includes(change.operation))) return false;
        if (index > 0) {
          const previous = entry.history[index - 1];
          if (change.operation === 'correct' && (previous.use === 'trashed' || change.use !== previous.use || change.body === previous.body)
            || change.operation === 'forget' && (previous.use === 'trashed' || change.use !== 'trashed' || change.body !== previous.body)
            || change.operation === 'restore' && (change.use === 'trashed' || change.use === previous.use || change.body !== previous.body)) return false;
          if (change.operation === 'undo') {
            const earlier = entry.history[index - 2];
            const expected = earlier ? value(earlier) : { body: previous.body, use: 'trashed' as const };
            if (previous.operation === 'undo' || !sameValue(change as unknown as MemoryValue, expected)) return false;
          }
        }
        previousTime = change.changedAt;
      }
      const last = entry.history.at(-1);
      if (last.body !== entry.body || last.use !== entry.use || last.changedAt !== entry.updatedAt) return false;
      // Undo must describe exactly the latest recorded mutation, not an arbitrary older snapshot.
      if (last.operation === 'undo') { if (entry.undo !== null) return false; }
      else {
        const undo = entry.undo;
        if (!record(undo) || !keys(undo, ['operation', 'afterRevision', 'previous']) || undo.operation !== last.operation || undo.afterRevision !== entry.revision) return false;
        if (last.operation === 'remember') { if (undo.previous !== null) return false; }
        else {
          const previous = entry.history.at(-2);
          if (!previous || !record(undo.previous) || !keys(undo.previous, ['body', 'use']) || undo.previous.body !== previous.body || undo.previous.use !== previous.use) return false;
        }
      }
    }
  }
  if (Object.hasOwn(input, 'memoryDrafts')) {
    if (!record(input.memoryDrafts)) return false;
    for (const [goalId, draft] of Object.entries(input.memoryDrafts)) {
      if (!goalIds.has(goalId) || !record(draft) || !keys(draft, ['memoryId', 'body', 'source'], ['sourceBody'])
        || !addId(draft.memoryId) || !draftBody(draft.body) || !validSource(draft.source, messageIds, noteIds)
        || (draft.source.kind === 'direct' ? Object.hasOwn(draft, 'sourceBody') : typeof draft.sourceBody !== 'string')) return false;
    }
  }
  return true;
}

function observedSource(state: DeskState, source: MemorySource): { body: string; goalId: string | null; complete: boolean } | null {
  if (source.kind === 'direct') return null;
  if (source.kind === 'note') {
    const note = state.notes.find((note) => note.id === source.id);
    return note ? { body: note.body, goalId: note.goalId, complete: true } : null;
  }
  const message = state.messages.find((message) => message.id === source.id);
  const session = message && state.sessions.find((session) => session.id === message.sessionId);
  return message && session ? { body: message.body, goalId: session.goalId, complete: message.status === 'complete' } : null;
}

function reviewedSource(state: DeskState, source: MemorySource, goalId: string, expected: string | undefined): void {
  if (!validSource(source, new Set(state.messages.map((message) => message.id)), new Set(state.notes.map((note) => note.id)))) refuse('That memory source is unavailable. Keep your draft and choose a current source.');
  if (source.kind === 'direct') { if (expected !== undefined) refuse('Direct teaching cannot carry an imported source.'); return; }
  const observed = observedSource(state, source);
  if (!observed || !observed.complete || observed.goalId !== goalId || expected === undefined || observed.body !== expected) refuse('The selected source changed or is outside this folder. Keep your draft and review it again.');
}

function reservedId(state: DeskState, memoryId: string, exceptDraftGoal?: string): boolean {
  return [...state.goals, ...state.sessions, ...state.messages, ...state.workItems, ...state.notes, ...state.activity, ...(state.memories ?? [])].some((entry) => entry.id === memoryId)
    || Object.entries(state.memoryDrafts ?? {}).some(([goalId, draft]) => goalId !== exceptDraftGoal && draft.memoryId === memoryId);
}

/** Mutates only an already cloned synthetic workspace; caller advances its shared revision. */
export function mutateMemory(state: DeskState, command: MemoryCommand, now: string): { changed: boolean; summary?: string; goalId?: string } {
  if (command.type === 'set-memory-draft') {
    if (!state.goals.some((goal) => goal.id === command.goalId)) refuse('The session folder no longer exists. Your memory draft was kept.');
    if (command.draft === null) {
      if (!state.memoryDrafts?.[command.goalId]) return { changed: false };
      delete state.memoryDrafts[command.goalId];
      return { changed: true };
    }
    const draft: MemoryDraft = structuredClone(command.draft);
    if (!record(draft) || !keys(draft, ['memoryId', 'body', 'source'], ['sourceBody']) || !id(draft.memoryId) || !draftBody(draft.body) || reservedId(state, draft.memoryId, command.goalId)) refuse('This memory draft has invalid text or identity. Your earlier draft was kept.');
    reviewedSource(state, draft.source, command.goalId, draft.sourceBody);
    const previous = state.memoryDrafts?.[command.goalId];
    if (previous && JSON.stringify(previous) === JSON.stringify(draft)) return { changed: false };
    (state.memoryDrafts ??= {})[command.goalId] = draft;
    return { changed: true };
  }
  if (command.type === 'remember-memory') {
    if (!id(command.memoryId) || !body(command.body)) refuse('A memory needs a valid identity and 1–4000 characters.');
    const text = command.body.trim();
    const existing = state.memories?.find((entry) => entry.id === command.memoryId);
    if (existing) {
      if (existing.goalId === command.goalId && sameSource(existing.source, command.source) && existing.history[0].body === text) return { changed: false };
      refuse('That memory identity already belongs to a different teaching. Your attempted text was not applied.');
    }
    if (!state.goals.some((goal) => goal.id === command.goalId) || reservedId(state, command.memoryId, command.goalId)) refuse('The memory folder or identity is unavailable. Your attempted text was not applied.');
    reviewedSource(state, command.source, command.goalId, command.expectedSourceBody);
    const entry: MemoryEntry = { id: command.memoryId, goalId: command.goalId, source: structuredClone(command.source), revision: 1, body: text, use: 'active', createdAt: now, updatedAt: now,
      history: [{ revision: 1, operation: 'remember', body: text, use: 'active', changedAt: now }], undo: { operation: 'remember', afterRevision: 1, previous: null } };
    (state.memories ??= []).push(entry);
    if (state.memoryDrafts?.[command.goalId]?.memoryId === entry.id) delete state.memoryDrafts[command.goalId];
    return { changed: true, summary: 'Chosen sample memory saved in this folder.', goalId: entry.goalId };
  }
  const entry = state.memories?.find((entry) => entry.id === command.memoryId);
  if (!entry) refuse('This memory no longer exists. Your attempted edit was not applied.');
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== entry.revision) refuse('This memory changed while you were editing. Keep your edit and reload before trying again.');
  if (command.type === 'set-memory-correction-draft') {
    if (command.text !== null && !draftBody(command.text)) refuse('A memory correction draft must be 4000 characters or fewer.');
    if ((entry.correctionDraft ?? null) === command.text) return { changed: false };
    if (command.text === null) delete entry.correctionDraft;
    else entry.correctionDraft = command.text;
    return { changed: true };
  }
  const previous = value(entry);
  if (entry.revision === Number.MAX_SAFE_INTEGER) refuse('This memory cannot advance its revision safely. No change was applied.');
  let operation: 'correct' | 'forget' | 'restore' | 'undo';
  let summary: string;
  if (command.type === 'correct-memory') {
    if (entry.use === 'trashed') refuse('Restore this memory before correcting it.');
    if (!body(command.body)) refuse('A memory needs 1–4000 characters. Your correction draft was kept.');
    const text = command.body.trim();
    if (text === entry.body) {
      if (entry.correctionDraft === undefined) return { changed: false };
      delete entry.correctionDraft;
      return { changed: true };
    }
    entry.body = text;
    delete entry.correctionDraft;
    operation = 'correct'; summary = 'Sample memory corrected; earlier text stays out of context.';
  } else if (command.type === 'forget-memory') {
    if (entry.use === 'trashed') return { changed: false };
    entry.use = 'trashed';
    // Pending edits are retained separately and never count as context.
    operation = 'forget'; summary = 'Sample memory moved to Trash and excluded from context.';
  } else if (command.type === 'restore-memory') {
    if (command.use !== 'active' && command.use !== 'view-only') refuse('Choose context use or viewing only before restoring.');
    if (entry.use === command.use) return { changed: false };
    entry.use = command.use;
    operation = 'restore'; summary = command.use === 'active' ? 'Sample memory restored for this folder; no outside permission added.' : 'Sample memory restored for viewing only, excluded from context.';
  } else {
    if (!entry.undo || entry.undo.afterRevision !== entry.revision) refuse('There is no current memory change to undo.');
    const earlier = entry.undo.previous;
    if (earlier) Object.assign(entry, earlier);
    else entry.use = 'trashed';
    operation = 'undo'; summary = 'Latest sample memory change undone.';
  }
  entry.revision += 1;
  entry.updatedAt = now;
  entry.history.push({ revision: entry.revision, operation, ...value(entry), changedAt: now });
  entry.undo = operation === 'undo' ? null : { operation, afterRevision: entry.revision, previous };
  return { changed: true, summary, goalId: entry.goalId };
}

/**
 * Deterministic synthetic context only, not an AI dispatch or privacy guarantee.
 * Sources stay readable, but selected raw text, history, drafts and Trash never
 * enter derived context. One blocked memory blocks other derivatives of its source.
 */
export function eligibleMemoryContext(state: DeskState, goalId: string) {
  const entries = state.memories ?? [];
  const selectedSources = new Set(entries.flatMap((entry) => entry.source.kind === 'direct' ? [] : [entry.source.id]));
  const scopedExclusions = new Set(entries.flatMap((entry) => entry.source.kind !== 'direct'
    && (entry.goalId === goalId || observedSource(state, entry.source)?.goalId === goalId) ? [entry.source.id] : []));
  const blockedSources = new Set(entries.flatMap((entry) => entry.use === 'active' || entry.source.kind === 'direct' ? [] : [entry.source.id]));
  const memories = entries.filter((entry) => entry.goalId === goalId && entry.use === 'active'
    && (entry.source.kind === 'direct' || !blockedSources.has(entry.source.id) && observedSource(state, entry.source)?.goalId === goalId && observedSource(state, entry.source)?.complete))
    .map((entry) => ({ id: entry.id, body: entry.body }));
  const sessions = new Set(state.sessions.filter((session) => session.goalId === goalId).map((session) => session.id));
  return {
    memories,
    messages: state.messages.filter((message) => sessions.has(message.sessionId) && message.status === 'complete' && !selectedSources.has(message.id)).map((message) => ({ id: message.id, body: message.body, role: message.role })),
    notes: state.notes.filter((note) => note.goalId === goalId && !selectedSources.has(note.id)).map((note) => ({ id: note.id, body: note.body })),
    excludedSourceIds: [...scopedExclusions],
  };
}
