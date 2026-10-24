import { isFolderIcon } from './folder-icons';
import { validateMemoryFields } from './memory';
import { isConversationRunClosed, validateConversationRun } from './conversation-runs';
import { validParticipantIdentity } from './participant-choices';
import type { DeskState } from './types';

export type StateValidation = { valid: true; state: DeskState } | { valid: false; error: string };

type RecordValue = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const identifier = (value: unknown): value is string => text(value) && uuid.test(value);
const timestamp = (value: unknown): value is string => {
  if (!text(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const oneOf = (value: unknown, choices: string[]) => text(value) && choices.includes(value);
const exact = (value: RecordValue, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const withOptional = (value: RecordValue, required: string[], optional: string[]) => required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

function textHistory(value: unknown, current: string, earliest: string, latest: string, maxLength: number, observedFirst = false): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  let previous = earliest;
  for (const [index, entry] of value.entries()) {
    if (!record(entry) || !exact(entry, ['text', 'createdAt']) || !text(entry.text)
      || observedFirst && !entry.text.trim()
      || (!observedFirst || index > 0) && entry.text.length > maxLength
      || !timestamp(entry.createdAt) || entry.createdAt < previous || entry.createdAt > latest) return false;
    previous = entry.createdAt;
  }
  return value.at(-1).text === current;
}

/** Reject incompatible/corrupt data in full; do not repair, strip, truncate or replace it. */
export function validateState(input: unknown): StateValidation {
  const invalid = (error: string): StateValidation => ({ valid: false, error });
  if (!record(input)) return invalid('The synthetic workspace is not an object.');
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) return invalid('This synthetic workspace version is unsupported. Its contents were kept.');
  if (!withOptional(input, ['schemaVersion', 'revision', 'updatedAt', 'goals', 'sessions', 'messages', 'drafts', 'goalDrafts', 'workItems', 'notes', 'activity', 'selection', 'preferences', 'capabilities', ...(input.schemaVersion === 2 ? ['conversationRuns'] : [])], ['memories', 'memoryDrafts'])) return invalid('The synthetic workspace has unexpected or missing fields.');
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || !timestamp(input.updatedAt)) return invalid('The synthetic workspace revision or timestamp is invalid.');
  const allIds = new Set<string>();
  const goalIds = new Set<string>();
  const sessionGoals = new Map<string, string | null>();
  const parents = new Map<string, string | null>();
  const addId = (value: unknown) => {
    if (!identifier(value) || allIds.has(value)) return false;
    allIds.add(value);
    return true;
  };
  const dated = (value: RecordValue) => timestamp(value.createdAt);
  const updated = (value: RecordValue) => dated(value) && timestamp(value.updatedAt) && value.updatedAt >= (value.createdAt as string);

  if (!Array.isArray(input.goals) || !input.goals.length) return invalid('The synthetic workspace needs a goal.');
  for (const value of input.goals) {
    if (!record(value) || !withOptional(value, ['id', 'title', 'nextStep', 'createdAt', 'updatedAt'], ['parentId', 'purpose', 'pinned', 'icon']) || !addId(value.id) || !text(value.title) || !value.title.trim() || !text(value.nextStep) || !updated(value) || !(value.parentId === undefined || value.parentId === null || identifier(value.parentId)) || !(value.purpose === undefined || (text(value.purpose) && value.purpose.length <= 4000)) || !(value.pinned === undefined || typeof value.pinned === 'boolean') || !(value.icon === undefined || isFolderIcon(value.icon))) return invalid('A domain has invalid fields, identity or timestamps.');
    goalIds.add(value.id as string);
    parents.set(value.id as string, (value.parentId as string | null | undefined) ?? null);
  }
  for (const id of goalIds) {
    const seen = new Set<string>([id]);
    let parent = parents.get(id);
    while (parent) {
      if (!goalIds.has(parent) || seen.has(parent)) return invalid('The domain hierarchy has a missing parent or a cycle.');
      seen.add(parent);
      parent = parents.get(parent);
    }
  }
  if (!record(input.goalDrafts) || Object.keys(input.goalDrafts).length !== goalIds.size || [...goalIds].some((id) => !Object.hasOwn(input.goalDrafts as RecordValue, id))) return invalid('Goal drafts do not match their goals.');
  for (const [id, value] of Object.entries(input.goalDrafts)) {
    if (!goalIds.has(id) || !record(value) || !withOptional(value, ['nextStep', 'workTitle'], ['purpose']) || !(value.nextStep === null || text(value.nextStep)) || !text(value.workTitle) || !(value.purpose === undefined || value.purpose === null || (text(value.purpose) && value.purpose.length <= 4000))) return invalid('A goal draft has invalid fields or a goal reference.');
  }
  if (!Array.isArray(input.sessions)) return invalid('Sessions must be a list.');
  for (const value of input.sessions) {
    if (!record(value) || !withOptional(value, ['id', 'goalId', 'title', 'createdAt', 'updatedAt'], ['pinned', 'titleHistory', 'intent', 'intentHistory', 'intentDraft', 'participantChoice']) || !addId(value.id) || !(value.goalId === null || (identifier(value.goalId) && goalIds.has(value.goalId))) || !text(value.title) || !value.title.trim() || !updated(value)) return invalid('A session has invalid fields, identity or domain reference.');
    if (Object.hasOwn(value, 'participantChoice') && !validParticipantIdentity(value.participantChoice)) return invalid('A saved participant choice is invalid.');
    if (!(value.pinned === undefined || typeof value.pinned === 'boolean')
      || !(value.intent === undefined || (text(value.intent) && value.intent.length <= 4000))
      || !(value.intentDraft === undefined || (text(value.intentDraft) && value.intentDraft.length <= 4000))
      || !(value.titleHistory === undefined || textHistory(value.titleHistory, value.title, value.createdAt as string, value.updatedAt as string, 180, true))
      || !(value.intentHistory === undefined || textHistory(value.intentHistory, (value.intent as string | undefined) ?? '', value.createdAt as string, value.updatedAt as string, 4000))) return invalid('Session pins, names or intent have invalid fields or history.');
    sessionGoals.set(value.id as string, value.goalId as string | null);
  }
  if (!record(input.drafts) || Object.keys(input.drafts).length !== sessionGoals.size || [...sessionGoals.keys()].some((id) => !Object.hasOwn(input.drafts as RecordValue, id))) return invalid('Drafts do not match their sessions.');
  for (const [id, value] of Object.entries(input.drafts)) {
    if (!sessionGoals.has(id) || !text(value)) return invalid('A draft has an invalid session reference or text.');
  }
  if (!Array.isArray(input.messages)) return invalid('Messages must be a list.');
  for (const value of input.messages) {
    if (!record(value) || !exact(value, ['id', 'sessionId', 'role', 'body', 'status', 'provenance', 'createdAt']) || !addId(value.id) || !identifier(value.sessionId) || !sessionGoals.has(value.sessionId) || !oneOf(value.role, ['user', 'assistant']) || !text(value.body) || !oneOf(value.status, ['complete', 'running', 'stopped', 'interrupted']) || (value.role === 'user' && value.status !== 'complete') || value.provenance !== 'simulation' || !dated(value)) return invalid('A message has invalid fields, identity or session reference.');
  }
  if (!Array.isArray(input.workItems)) return invalid('Work must be a list.');
  for (const value of input.workItems) {
    if (!record(value) || !withOptional(value, ['id', 'goalId', 'title', 'status', 'createdAt'], ['roadmapColumn']) || !addId(value.id) || !identifier(value.goalId) || !goalIds.has(value.goalId) || !text(value.title) || !value.title.trim() || !oneOf(value.status, ['planned', 'active', 'returned']) || !(value.roadmapColumn === undefined || value.roadmapColumn === 'suggested') || !dated(value)) return invalid('A work item has invalid fields, identity or goal reference.');
  }
  if (!Array.isArray(input.notes)) return invalid('Notes must be a list.');
  for (const value of input.notes) {
    if (!record(value) || !exact(value, ['id', 'goalId', 'body', 'createdAt']) || !addId(value.id) || !identifier(value.goalId) || !goalIds.has(value.goalId) || !text(value.body) || !value.body.trim() || !dated(value)) return invalid('A note has invalid fields, identity or goal reference.');
  }
  if (!validateMemoryFields(input, goalIds, new Set(input.messages.map((message) => message.id)), new Set(input.notes.map((note) => note.id)), addId)) return invalid('A sample memory or draft has invalid fields, history, identity or source references.');
  if (!Array.isArray(input.activity)) return invalid('Activity must be a list.');
  for (const value of input.activity) {
    // Earlier activity keeps its historical domain when a session is refiled.
    if (!record(value) || !exact(value, ['id', 'goalId', 'sessionId', 'kind', 'summary', 'createdAt']) || !addId(value.id) || !(value.goalId === null || (identifier(value.goalId) && goalIds.has(value.goalId))) || !(value.sessionId === null || (identifier(value.sessionId) && sessionGoals.has(value.sessionId))) || !oneOf(value.kind, ['created', 'edited', 'sent', 'responded', 'stopped', 'interrupted', 'noted']) || !text(value.summary) || !dated(value)) return invalid('An activity entry has invalid fields or references.');
  }
  if (input.schemaVersion === 2) {
    if (!Array.isArray(input.conversationRuns)) return invalid('Conversation runs must be a list.');
    // Include memory IDs, unsent memory IDs and activity IDs, not just visible messages.
    const occupiedIds = new Set([...allIds].map((id) => id.toLowerCase()));
    const activeSessions = new Set<string>();
    for (const run of input.conversationRuns) {
      if (!validateConversationRun(run) || !sessionGoals.has(run.sessionId)) return invalid('A conversation run has invalid fields or a session reference.');
      const session = input.sessions.find((value) => value.id === run.sessionId);
      if (run.createdAt < session.createdAt || run.updatedAt > input.updatedAt || run.closure && run.closure.at > input.updatedAt
        || run.cleanupAcknowledgment && run.cleanupAcknowledgment.at > input.updatedAt) return invalid('A conversation run has invalid chronology.');
      for (const id of [run.runId, run.userMessageId, run.assistantMessageId]) {
        if (occupiedIds.has(id.toLowerCase())) return invalid('A conversation run has a duplicate identity.');
        occupiedIds.add(id.toLowerCase());
      }
      if (!isConversationRunClosed(run)) {
        if (activeSessions.has(run.sessionId)) return invalid('A session has more than one unfinished conversation run.');
        activeSessions.add(run.sessionId);
      }
    }
  }
  if (!record(input.selection) || !exact(input.selection, ['goalId', 'sessionId', 'route']) || !(input.selection.goalId === null || (identifier(input.selection.goalId) && goalIds.has(input.selection.goalId))) || !(input.selection.sessionId === null || (identifier(input.selection.sessionId) && sessionGoals.has(input.selection.sessionId) && sessionGoals.get(input.selection.sessionId) === input.selection.goalId)) || !oneOf(input.selection.route, ['setup', 'sessions', 'work', 'memory', 'data'])) return invalid('The selected session, domain or route is invalid.');
  if (!record(input.preferences) || !withOptional(input.preferences, ['theme'], ['nexusView']) || !oneOf(input.preferences.theme, ['system', 'light', 'dark']) || !(input.preferences.nexusView === undefined || oneOf(input.preferences.nexusView, ['navigator', 'canvas', 'atlas', 'railmap', 'roadmap']))) return invalid('A view preference is invalid.');
  if (!record(input.capabilities) || !exact(input.capabilities, ['mode', 'provider', 'native']) || input.capabilities.mode !== 'synthetic' || input.capabilities.provider !== (input.schemaVersion === 1 ? 'demo-only' : 'runtime-selected') || input.capabilities.native !== 'unavailable') return invalid('The invented-data workspace has invalid capability metadata.');
  return { valid: true, state: input as unknown as DeskState };
}
