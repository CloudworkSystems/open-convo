import { DomainError } from './commands';
import type { ConversationRun } from './conversation-run-types';
import { conversationRunSerializedBytes, freezeConversationRun, isConversationRunClosed, validateConversationRun } from './conversation-runs';
import type { DeskState } from './types';
import { validateState } from './validation';

/** Match the native proof's whole-record and individual-text ceilings. */
export const WORKSPACE_RUN_LIMIT_BYTES = 1_048_576;
export const WORKSPACE_TEXT_LIMIT_BYTES = 65_536;
/** Room for bounded terminal/closure evidence and small later edits, not unlimited future work. */
export const RESERVED_RUN_RECOVERY_BYTES = 32_768;
/** Fixed acknowledgment field plus revision growth; any unacknowledged run may need it later. */
export const RESERVED_RUN_ACKNOWLEDGMENT_BYTES = 128;
const invalidWorkspace = 'The conversation workspace is invalid. No changes were applied.';
const invalidPreparation = 'The conversation could not be prepared. The draft and saved work were kept.';
const invalidCheckpoint = 'The conversation checkpoint could not be applied. Existing work was kept.';
const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
// Selection UUIDs have fixed length; these are the longest validated route and
// preference values. Charge their maximum even when the current view is smaller
// so navigation cannot spend capacity already promised to a response/checkpoint.
const maximumViewBytes = jsonBytes({ goalId: '00000000-0000-4000-8000-000000000000',
  sessionId: '00000000-0000-4000-8000-000000000000', route: 'sessions' })
  + jsonBytes({ theme: 'system', nexusView: 'navigator' });
interface WorkspaceSize { bytes: number; viewReserveBytes: number; invalidText: number; invalidValue: boolean; runBytes: Map<string, number> }
// Only our fresh, deeply frozen results enter this cache. External mutable values
// are measured again; a caller changing a field cannot reuse a stale allowance.
const frozenWorkspaces = new WeakMap<DeskState, WorkspaceSize>();

function validText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return encoder.encode(value).byteLength <= WORKSPACE_TEXT_LIMIT_BYTES;
}

function measure(state: DeskState): WorkspaceSize | null {
  const known = frozenWorkspaces.get(state);
  if (known) return known;
  try {
    if (!validateState(state).valid) return null;
    const pending: unknown[] = [state];
    const seen = new Set<object>();
    let invalidText = 0;
    let invalidValue = false;
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === 'string') { if (!validText(value)) invalidText++; }
      else if (value !== null && typeof value === 'object') {
        if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) invalidValue = true;
        if (seen.has(value)) continue;
        seen.add(value);
        pending.push(...Object.values(value));
      } else if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) invalidValue = true;
    }
    const runBytes = new Map<string, number>();
    for (const run of state.conversationRuns ?? []) {
      const bytes = conversationRunSerializedBytes(run);
      if (bytes === null) return null;
      runBytes.set(run.runId, bytes);
    }
    return { bytes: jsonBytes(state),
      viewReserveBytes: maximumViewBytes - jsonBytes(state.selection) - jsonBytes(state.preferences),
      invalidText, invalidValue, runBytes };
  } catch { return null; }
}

/** Proof-size check only; true neither writes the value nor grants runtime authority. */
export function canSaveConversationWorkspace(state: DeskState, reserveBytes = 0): boolean {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > WORKSPACE_RUN_LIMIT_BYTES) return false;
  const size = measure(state);
  return !!size && !size.invalidValue && size.invalidText === 0 && size.bytes <= WORKSPACE_RUN_LIMIT_BYTES - reserveBytes;
}

function sameChunks(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((chunk, index) => chunk === second[index]);
}
function keepsPrefix(prefix: string[], output: string[]): boolean {
  let chunkIndex = 0;
  let offset = 0;
  for (const chunk of prefix) {
    let consumed = 0;
    while (consumed < chunk.length) {
      const target = output[chunkIndex];
      if (target === undefined) return false;
      const width = Math.min(chunk.length - consumed, target.length - offset);
      if (chunk.slice(consumed, consumed + width) !== target.slice(offset, offset + width)) return false;
      consumed += width; offset += width;
      if (offset === target.length) { chunkIndex++; offset = 0; }
    }
  }
  return true;
}
function sameOrigin(first: ConversationRun, second: ConversationRun): boolean {
  return first.runId === second.runId && first.sessionId === second.sessionId
    && first.userMessageId === second.userMessageId && first.assistantMessageId === second.assistantMessageId
    && first.createdAt === second.createdAt && sameChunks(first.inputChunks, second.inputChunks)
    && first.participant.id === second.participant.id && first.participant.label === second.participant.label
    && first.participant.model === second.participant.model && first.participant.executionHost === second.participant.executionHost;
}
function sameEvidence(first: ConversationRun, second: ConversationRun): boolean {
  return sameOrigin(first, second) && first.phase === second.phase && first.lastSequence === second.lastSequence
    && first.updatedAt === second.updatedAt && first.reason === second.reason && sameChunks(first.outputChunks, second.outputChunks);
}
function sameClosure(first: ConversationRun['closure'], second: ConversationRun['closure']): boolean {
  if (!first || !second) return first === second;
  if (first.kind !== second.kind || first.reason !== second.reason || first.at !== second.at) return false;
  if (first.kind === 'unknown' || second.kind === 'unknown') return first.kind === second.kind;
  if (first.reason === 'replay-lost' || second.reason === 'replay-lost') {
    if (first.reason !== 'replay-lost' || second.reason !== 'replay-lost'
      || first.lost.fromSequence !== second.lost.fromSequence || first.lost.throughSequence !== second.lost.throughSequence
      || first.lost.reason !== second.lost.reason) return false;
  }
  const a = first.terminalEvent; const b = second.terminalEvent;
  return a.runId === b.runId && a.sessionId === b.sessionId && a.sequence === b.sequence
    && a.type === b.type && a.at === b.at && ('reason' in a ? a.reason : undefined) === ('reason' in b ? b.reason : undefined);
}
function sameRun(first: ConversationRun, second: ConversationRun): boolean {
  return sameEvidence(first, second) && sameClosure(first.closure, second.closure)
    && first.cleanupAcknowledgment?.kind === second.cleanupAcknowledgment?.kind
    && first.cleanupAcknowledgment?.at === second.cleanupAcknowledgment?.at;
}
const recordTime = (run: ConversationRun) => run.cleanupAcknowledgment?.at ?? run.closure?.at ?? run.updatedAt;
function addsCleanupAcknowledgment(previous: ConversationRun, next: ConversationRun): boolean {
  return isConversationRunClosed(previous) && !previous.cleanupAcknowledgment && !!next.cleanupAcknowledgment
    && sameEvidence(previous, next) && sameClosure(previous.closure, next.closure);
}

function retainsRunEvidence(previous: ConversationRun, candidate: ConversationRun): boolean {
  return sameOrigin(previous, candidate) && candidate.lastSequence >= previous.lastSequence
    && candidate.updatedAt >= previous.updatedAt && keepsPrefix(previous.outputChunks, candidate.outputChunks)
    && (candidate.lastSequence !== previous.lastSequence || sameEvidence(previous, candidate))
    && (!isConversationRunClosed(previous) || sameRun(previous, candidate) || addsCleanupAcknowledgment(previous, candidate));
}

/**
 * Keep space for every already observed prefix while assessing an ordinary edit.
 * This only projects existing IDs; it neither prepares runs nor changes state.
 * Selection/preferences always count at their maximum validated size.
 * One KiB per unfinished run preserves closure room without withholding the
 * larger streaming allowance after text admission has stopped. Every run without
 * a cleanup acknowledgment also keeps its fixed acknowledgment allowance: a
 * currently closed run can require an explicit cleanup choice after reopening.
 */
export function canSaveConversationWorkspaceWithRuns(state: DeskState, records: readonly ConversationRun[], previousView?: DeskState): boolean {
  try {
    const size = measure(state);
    if (!size || size.invalidValue || size.invalidText !== 0) return false;
    const projected = new Map((state.conversationRuns ?? []).map((run) => [run.runId, run]));
    const seen = new Set<string>();
    let bytes = size.bytes + size.viewReserveBytes;
    let pendingCheckpoints = 0;
    let updatedAt = state.updatedAt;
    for (const run of records) {
      const runBytes = conversationRunSerializedBytes(run);
      const previous = projected.get(run.runId);
      if (runBytes === null || !previous || seen.has(run.runId) || !retainsRunEvidence(previous, run)) return false;
      seen.add(run.runId);
      bytes += runBytes - size.runBytes.get(run.runId)!;
      if (!sameRun(previous, run)) pendingCheckpoints++;
      if (recordTime(run) > updatedAt) updatedAt = recordTime(run);
      projected.set(run.runId, run);
    }
    // Pending checkpoints can cross a decimal revision boundary. Count that
    // small future metadata growth without actually advancing the revision.
    const projectedRevision = state.revision + pendingCheckpoints;
    if (!Number.isSafeInteger(projectedRevision)) return false;
    bytes += String(projectedRevision).length - String(state.revision).length;
    bytes += jsonBytes(updatedAt) - jsonBytes(state.updatedAt);
    const unfinished = [...projected.values()].filter((run) => !isConversationRunClosed(run)).length;
    if (bytes <= WORKSPACE_RUN_LIMIT_BYTES - unfinished * 1024 - cleanupAcknowledgmentReserve(projected.values())) return true;
    // Legacy records may lack today's reserves. View commands do not write
    // content; allow either direction within the actual native byte ceiling,
    // including the pending prefixes already counted above. Comparing against
    // the immediately preceding view creates a one-way size ratchet. Independently
    // verify every non-view field so a content edit cannot use this exception.
    if (!previousView || !canSaveConversationWorkspace(previousView) || !canSaveConversationWorkspace(state)) return false;
    return bytes - size.viewReserveBytes <= WORKSPACE_RUN_LIMIT_BYTES
      && JSON.stringify({ ...previousView, selection: null, preferences: null })
        === JSON.stringify({ ...state, selection: null, preferences: null });
  } catch { return false; }
}

function cleanupAcknowledgmentReserve(runs: Iterable<ConversationRun>): number {
  let reserve = 0;
  for (const run of runs) if (!run.cleanupAcknowledgment) reserve += RESERVED_RUN_ACKNOWLEDGMENT_BYTES;
  return reserve;
}

export function conversationRecoveryReserve(state: DeskState): number {
  const unfinished = (state.conversationRuns ?? []).filter((run) => !isConversationRunClosed(run)).length;
  return RESERVED_RUN_RECOVERY_BYTES + Math.max(0, unfinished - 1) * 1024
    + cleanupAcknowledgmentReserve(state.conversationRuns ?? []);
}

/**
 * Project the entire workspace before accepting another run/text update. Live
 * runs leave recovery headroom. Closed records can use their closure room while
 * retaining each unacknowledged run's fixed cleanup allowance. The controller
 * must admit each text advance or cleanup choice before accepting it.
 */
export function canAdmitConversationRun(state: DeskState, run: ConversationRun, otherRuns: readonly ConversationRun[] = []): boolean {
  try {
    const size = measure(state);
    if (!size || size.invalidValue || state.revision >= Number.MAX_SAFE_INTEGER) return false;
    const projected = new Map((state.conversationRuns ?? []).map((entry) => [entry.runId, entry]));
    const replacements = new Map<string, ConversationRun>();
    for (const other of otherRuns) {
      if (other.runId === run.runId || replacements.has(other.runId)) return false;
      replacements.set(other.runId, other);
    }
    replacements.set(run.runId, run);
    let bytes = size.bytes + size.viewReserveBytes + String(state.revision + 1).length - String(state.revision).length;
    let invalidText = size.invalidText;
    let updatedAt = state.updatedAt;
    let migrated = state.schemaVersion === 2;
    let adding = false;
    const drafts = { ...state.drafts };
    for (const candidate of replacements.values()) {
      const runBytes = conversationRunSerializedBytes(candidate);
      if (runBytes === null) return false;
      if (recordTime(candidate) > updatedAt) updatedAt = recordTime(candidate);
      const previous = projected.get(candidate.runId);
      if (previous) {
        if (!retainsRunEvidence(previous, candidate)) return false;
        bytes += runBytes - size.runBytes.get(candidate.runId)!;
      } else {
        if (candidate.phase !== 'prepared' || candidate.closure || drafts[candidate.sessionId] !== candidate.inputChunks.join('')) return false;
        bytes += jsonBytes('') - jsonBytes(drafts[candidate.sessionId]);
        if (!validText(drafts[candidate.sessionId])) invalidText--;
        drafts[candidate.sessionId] = '';
        bytes += runBytes;
        if (!migrated) {
          bytes += jsonBytes({ conversationRuns: [] }) - 2 + 1;
          bytes += jsonBytes('runtime-selected') - jsonBytes(state.capabilities.provider);
          migrated = true;
        } else if (projected.size) bytes++;
        adding = true;
      }
      projected.set(candidate.runId, candidate);
    }
    bytes += jsonBytes(updatedAt) - jsonBytes(state.updatedAt);
    const projection: DeskState = { ...state, schemaVersion: 2,
      capabilities: { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' },
      conversationRuns: [...projected.values()], drafts, revision: state.revision + 1, updatedAt };
    // Existing replacements keep their validated origin IDs. New entries also
    // need the complete cross-record identity/session checks before admission.
    if (adding && !validateState(projection).valid) return false;
    const unfinished = [...projected.values()].filter((candidate) => !isConversationRunClosed(candidate)).length;
    const reserve = isConversationRunClosed(run)
      ? unfinished * 1024 + cleanupAcknowledgmentReserve(projected.values())
      : conversationRecoveryReserve(projection);
    return invalidText === 0 && bytes <= WORKSPACE_RUN_LIMIT_BYTES - reserve;
  } catch { return false; }
}

function requireWorkspace(state: DeskState): void {
  try { if (frozenWorkspaces.has(state) || validateState(state).valid) return; } catch { /* Fixed refusal only. */ }
  throw new DomainError(invalidWorkspace);
}
function freezeWorkspace(next: DeskState): DeskState {
  for (let index = 0; index < (next.conversationRuns?.length ?? 0); index++) {
    const captured = freezeConversationRun(next.conversationRuns![index]);
    if (captured.kind !== 'ok') throw new DomainError(invalidWorkspace);
    next.conversationRuns![index] = captured.run;
  }
  const pending: object[] = [next];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push(child);
    Object.freeze(value);
  }
  const size = measure(next);
  if (!size) throw new DomainError(invalidWorkspace);
  frozenWorkspaces.set(next, size);
  return next;
}
/** Capture mutable caller state once; future admission checks use only this owned immutable copy. */
export function captureConversationWorkspace(state: DeskState): DeskState {
  requireWorkspace(state);
  if (frozenWorkspaces.has(state)) return state;
  try { return freezeWorkspace(structuredClone(state)); }
  catch { throw new DomainError(invalidWorkspace); }
}

function finish(state: DeskState, next: DeskState, at: string, refusal: string): DeskState {
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new DomainError(refusal);
  next.revision = state.revision + 1;
  next.updatedAt = state.updatedAt > at ? state.updatedAt : at;
  if (!validateState(next).valid || !canSaveConversationWorkspace(next)) throw new DomainError(refusal);
  return freezeWorkspace(next);
}

/** Pure preparation, not a disk save or dispatch; simulation messages stay literal. */
export function prepareConversationRun(state: DeskState, run: ConversationRun, expectedDraft: string): DeskState {
  requireWorkspace(state);
  if (!validateConversationRun(run) || run.phase !== 'prepared' || run.closure || run.lastSequence !== 0
    || run.outputChunks.length !== 0 || typeof expectedDraft !== 'string'
    || run.inputChunks.join('') !== expectedDraft || state.drafts[run.sessionId] !== expectedDraft
    || !state.sessions.some((session) => session.id === run.sessionId)
    || state.conversationRuns?.some((existing) => existing.sessionId === run.sessionId && !isConversationRunClosed(existing))
    || !canAdmitConversationRun(state, run)) throw new DomainError(invalidPreparation);
  const next = structuredClone(state);
  next.schemaVersion = 2;
  next.capabilities = { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' };
  next.conversationRuns ??= [];
  next.conversationRuns.push(structuredClone(run));
  next.drafts[run.sessionId] = '';
  return finish(state, next, recordTime(run), invalidPreparation);
}

/** Checkpoint values are not durable until the repository confirms the exact save. */
export function saveConversationRunCheckpoint(state: DeskState, run: ConversationRun, expectedSequence: number): DeskState {
  requireWorkspace(state);
  if (state.schemaVersion !== 2 || !validateConversationRun(run)
    || !Number.isSafeInteger(expectedSequence) || expectedSequence < 0) throw new DomainError(invalidCheckpoint);
  const index = state.conversationRuns!.findIndex((existing) => existing.runId === run.runId);
  const previous = state.conversationRuns![index];
  if (!previous || !sameOrigin(previous, run)) throw new DomainError(invalidCheckpoint);
  if (sameRun(previous, run)) return state;
  const advancing = run.lastSequence > previous.lastSequence && run.updatedAt >= previous.updatedAt
    && ['prepared', 'running'].includes(previous.phase) && run.phase !== 'prepared'
    && keepsPrefix(previous.outputChunks, run.outputChunks);
  // A closure may coalesce an already observed, unsaved prefix. Validate that
  // open prefix separately; do not require another potentially blocked write.
  const prefix = { ...run };
  delete prefix.closure;
  delete prefix.cleanupAcknowledgment;
  const closing = !previous.closure && !!run.closure
    && (sameEvidence(previous, run) || advancing && validateConversationRun(prefix));
  const acknowledging = addsCleanupAcknowledgment(previous, run);
  if (previous.lastSequence !== expectedSequence || isConversationRunClosed(previous) && !acknowledging
    || (!acknowledging && (run.closure ? !closing : !advancing))
    || !canSaveConversationWorkspaceWithRuns(state, [run])) throw new DomainError(invalidCheckpoint);
  const next = structuredClone(state);
  next.conversationRuns![index] = structuredClone(run);
  return finish(state, next, recordTime(run), invalidCheckpoint);
}
