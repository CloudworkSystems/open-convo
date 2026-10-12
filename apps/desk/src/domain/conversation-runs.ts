import type { ConversationRun, ConversationRunClosure, ParticipantEvent, ParticipantIdentity, ParticipantStopReason } from './conversation-run-types';

/** Invented-data proof limits, not final limits for real conversations. */
export const MAX_RUN_CHUNK_BYTES = 16 * 1024;
export const MAX_RUN_TEXT_BYTES = 256 * 1024;
export const MAX_RUN_SERIALIZED_BYTES = 768 * 1024;
/** New open records reserve this within the serialized cap for terminal recovery. */
export const MAX_RUN_CLOSURE_BYTES = 1024;
export const MAX_PARTICIPANT_FIELD_BYTES = 256;

export type ConversationRunRefusal = 'invalid-arguments' | 'invalid-run' | 'invalid-event' | 'invalid-text'
  | 'text-limit' | 'run-size-limit' | 'target-mismatch' | 'sequence-mismatch' | 'invalid-transition' | 'invalid-closure';
export type RunRefusal = { readonly kind: 'refused'; readonly reason: ConversationRunRefusal };
export type ConversationRunResult = { readonly kind: 'ok'; readonly run: ConversationRun } | RunRefusal;
export type RunChunksResult = { readonly kind: 'ok'; readonly chunks: string[] } | RunRefusal;
export type RunTextResult = { readonly kind: 'ok'; readonly text: string } | RunRefusal;

export interface CreateConversationRunArgs {
  runId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  participant: ParticipantIdentity;
  input: string;
  createdAt: string;
}

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runKeys = ['version', 'runId', 'sessionId', 'userMessageId', 'assistantMessageId', 'participant',
  'inputChunks', 'outputChunks', 'lastSequence', 'phase', 'createdAt', 'updatedAt'];
const eventKeys = ['runId', 'sessionId', 'sequence', 'at', 'type'];
const createKeys = ['runId', 'sessionId', 'userMessageId', 'assistantMessageId', 'participant', 'input', 'createdAt'];
const refuse = (reason: ConversationRunRefusal): RunRefusal => ({ kind: 'refused', reason });
const stopReasons: readonly ParticipantStopReason[] = ['local-stop', 'stop-incomplete', 'reply-too-long', 'paid-overflow', 'timeout', 'process-error'];
type RunMetrics = { inputBytes: number; outputBytes: number; tailBytes: number; serializedBytes: number };
// Only deeply frozen captured records enter this cache. Mutable external values
// are always checked in full; an earlier successful validation is no authority.
const validatedRuns = new WeakMap<object, RunMetrics>();

/** Inspect only own data properties: an accessor is not a saved JSON field. */
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return shape(value, keys, []);
}

function shape(value: unknown, required: readonly string[], optional: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return required.every((key) => Object.hasOwn(value, key)) && own.every((key) => typeof key === 'string'
    && (required.includes(key) || optional.includes(key))
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

/** A negative result means unpaired UTF-16; no replacement character is manufactured. */
function scalarBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return -1;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return -1;
    else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function metadata(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_PARTICIPANT_FIELD_BYTES) return false;
  const size = scalarBytes(value);
  return size > 0 && size <= MAX_PARTICIPANT_FIELD_BYTES;
}

function participant(value: unknown): value is ParticipantIdentity {
  return exact(value, ['id', 'label', 'model', 'executionHost'])
    && ['id', 'label', 'model', 'executionHost'].every((key) => metadata(value[key]));
}

function identities(value: Record<string, unknown>): boolean {
  return ['runId', 'userMessageId', 'assistantMessageId'].every((key) => typeof value[key] === 'string' && v4.test(value[key]))
    && typeof value.sessionId === 'string' && recordId.test(value.sessionId)
    && new Set([value.runId, value.userMessageId, value.assistantMessageId, value.sessionId.toLowerCase()]).size === 4;
}

/** Returns -1 for invalid chunks, including sparse arrays, accessors and extra properties. */
function chunkBytes(value: unknown): number {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_RUN_TEXT_BYTES
    || Reflect.ownKeys(value).length !== value.length + 1) return -1;
  let total = 0;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
      || typeof descriptor.value !== 'string' || descriptor.value.length === 0
      || descriptor.value.length > MAX_RUN_CHUNK_BYTES) return -1;
    const bytes = scalarBytes(descriptor.value);
    if (bytes < 1 || bytes > MAX_RUN_CHUNK_BYTES) return -1;
    total += bytes;
    if (total > MAX_RUN_TEXT_BYTES) return -1;
  }
  return total;
}

/** Literal chunks are independent Unicode-scalar strings, never sliced surrogate halves. */
export function chunkRunText(value: unknown): RunChunksResult {
  if (typeof value !== 'string') return refuse('invalid-text');
  if (value.length > MAX_RUN_TEXT_BYTES) return refuse('text-limit');
  const bytes = scalarBytes(value);
  if (bytes < 0) return refuse('invalid-text');
  if (bytes > MAX_RUN_TEXT_BYTES) return refuse('text-limit');
  const chunks: string[] = [];
  let start = 0;
  let size = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index)!;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (size + width > MAX_RUN_CHUNK_BYTES) {
      chunks.push(value.slice(start, index));
      start = index;
      size = 0;
    }
    size += width;
    index += code > 0xffff ? 2 : 1;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return { kind: 'ok', chunks };
}

export function joinRunChunks(value: unknown): RunTextResult {
  try {
    if (chunkBytes(value) < 0) return refuse('invalid-text');
    return { kind: 'ok', text: (value as string[]).join('') };
  } catch { return refuse('invalid-text'); }
}

function phaseConsistent(run: Record<string, unknown>): boolean {
  const sequence = run.lastSequence as number;
  const emptyOutput = (run.outputChunks as string[]).length === 0;
  switch (run.phase) {
    case 'prepared': return sequence === 0 && emptyOutput && run.updatedAt === run.createdAt;
    case 'running': return sequence >= 1 && (sequence > 1 || emptyOutput);
    case 'completed': return sequence >= 2 && (sequence > 2 || emptyOutput);
    case 'stopped':
    case 'failed': return sequence >= 1 && (sequence > 2 || emptyOutput);
    case 'unknown': return sequence >= 0 && (sequence > 1 || emptyOutput);
    default: return false;
  }
}

function terminalPhase(phase: unknown): boolean {
  return phase === 'completed' || phase === 'stopped' || phase === 'failed';
}

/** The closure does not manufacture a missing text event or change its last saved sequence. */
function validClosure(value: unknown, run: ConversationRun, legacySaved = false): value is ConversationRunClosure {
  if (terminalPhase(run.phase) || !shape(value, ['kind', 'reason', 'at'], ['terminalEvent', 'lost'])
    || !date(value.at) || value.at < run.updatedAt) return false;
  if (value.kind === 'unknown') return value.reason === 'user-closed' && !Object.hasOwn(value, 'terminalEvent') && !Object.hasOwn(value, 'lost');
  if (value.kind !== 'interrupted' || !['event-refused', 'workspace-limit', 'replay-lost'].includes(value.reason as string)
    || !validateEvent(value.terminalEvent, legacySaved)) return false;
  const event = value.terminalEvent;
  if (value.reason === 'replay-lost') {
    if (!exact(value.lost, ['fromSequence', 'throughSequence', 'reason'])
      || !Number.isSafeInteger(value.lost.fromSequence) || !Number.isSafeInteger(value.lost.throughSequence)
      || value.lost.fromSequence !== run.lastSequence + 1 || value.lost.throughSequence !== event.sequence - 1
      || (value.lost.throughSequence as number) < (value.lost.fromSequence as number)
      || !['locked', 'closed', 'restarted', 'replaced'].includes(value.lost.reason as string)) return false;
  } else if (Object.hasOwn(value, 'lost')) return false;
  return terminalPhase(event.type) && event.runId === run.runId && event.sessionId === run.sessionId
    && event.sequence > run.lastSequence && value.at >= event.at;
}

function readMetrics(value: unknown): RunMetrics | null {
  try {
    if (typeof value === 'object' && value !== null) {
      const cached = validatedRuns.get(value);
      if (cached) return cached;
    }
    if (!shape(value, runKeys, ['reason', 'closure', 'cleanupAcknowledgment']) || value.version !== 1 || !identities(value) || !participant(value.participant)
      || !Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0
      || !date(value.createdAt) || !date(value.updatedAt) || value.updatedAt < value.createdAt) return null;
    const input = chunkBytes(value.inputChunks);
    const output = chunkBytes(value.outputChunks);
    if (input <= 0 || output < 0 || input + output > MAX_RUN_TEXT_BYTES || !phaseConsistent(value)) return null;
    if (Object.hasOwn(value, 'reason') && (!['stopped', 'failed'].includes(value.phase as string)
      || !stopReasons.includes(value.reason as ParticipantStopReason))) return null;
    if (Object.hasOwn(value, 'closure') && !validClosure(value.closure, value as unknown as ConversationRun, true)) return null;
    if (Object.hasOwn(value, 'cleanupAcknowledgment')) {
      const ack = value.cleanupAcknowledgment;
      if (!exact(ack, ['kind', 'at']) || ack.kind !== 'unreachable' || !date(ack.at)
        || !isConversationRunClosed(value as unknown as ConversationRun)
        || ack.at < value.updatedAt || ack.at < ((value.closure as ConversationRunClosure | undefined)?.at ?? value.updatedAt)) return null;
    }
    const serializedBytes = scalarBytes(JSON.stringify(value));
    const acknowledgmentBytes = Object.hasOwn(value, 'cleanupAcknowledgment')
      ? scalarBytes(JSON.stringify({ cleanupAcknowledgment: value.cleanupAcknowledgment })) - 1 : 0;
    const closureBytes = Object.hasOwn(value, 'closure') ? scalarBytes(JSON.stringify({ closure: value.closure })) - 1 : 0;
    // A legacy prefix may predate the recovery reserve. Its bounded local
    // closure may exceed the former cap; none of its original text is removed.
    if (closureBytes + acknowledgmentBytes > MAX_RUN_CLOSURE_BYTES || serializedBytes - closureBytes - acknowledgmentBytes > MAX_RUN_SERIALIZED_BYTES) return null;
    const outputChunks = value.outputChunks as string[];
    return { inputBytes: input, outputBytes: output, tailBytes: scalarBytes(outputChunks.at(-1) ?? ''), serializedBytes };
  } catch { return null; }
}

/** Strict saved-record validation; only our immutable captures can use cached validation. */
export function validateConversationRun(value: unknown): value is ConversationRun { return readMetrics(value) !== null; }

/** Exact JSON UTF-8 size; the workspace admission check may reuse immutable run evidence. */
export function conversationRunSerializedBytes(value: unknown): number | null { return readMetrics(value)?.serializedBytes ?? null; }

function remember(run: ConversationRun, metrics: RunMetrics): ConversationRun {
  Object.freeze(run.participant);
  Object.freeze(run.inputChunks);
  Object.freeze(run.outputChunks);
  if (run.closure) {
    if (run.closure.kind === 'interrupted') {
      Object.freeze(run.closure.terminalEvent);
      if (run.closure.reason === 'replay-lost') Object.freeze(run.closure.lost);
    }
    Object.freeze(run.closure);
  }
  if (run.cleanupAcknowledgment) Object.freeze(run.cleanupAcknowledgment);
  Object.freeze(run);
  validatedRuns.set(run, metrics);
  return run;
}

/** Capture once at a trust boundary, then retain reducer result identity for fast appends. */
export function freezeConversationRun(value: unknown): ConversationRunResult {
  const metrics = readMetrics(value);
  if (!metrics) return refuse('invalid-run');
  const source = value as ConversationRun;
  if (validatedRuns.has(source)) return { kind: 'ok', run: source };
  const run: ConversationRun = { ...source, participant: { ...source.participant },
    inputChunks: source.inputChunks.slice(), outputChunks: source.outputChunks.slice(),
    ...(source.cleanupAcknowledgment ? { cleanupAcknowledgment: { ...source.cleanupAcknowledgment } } : {}),
    ...(source.closure ? { closure: source.closure.kind === 'interrupted'
      ? { ...source.closure, terminalEvent: { ...source.closure.terminalEvent },
        ...(source.closure.reason === 'replay-lost' ? { lost: { ...source.closure.lost } } : {}) } : { ...source.closure } } : {}) };
  return { kind: 'ok', run: remember(run, metrics) };
}

export function isConversationRunClosed(run: ConversationRun): boolean { return terminalPhase(run.phase) || run.closure !== undefined; }

export function validateParticipantEvent(value: unknown): value is ParticipantEvent { return validateEvent(value, false); }
// Preserve readable legacy saved evidence; only newly received events enforce
// the corrected paid-overflow reason restriction.
function validateEvent(value: unknown, legacySaved: boolean): value is ParticipantEvent {
  try {
    if (!shape(value, eventKeys, ['text', 'reason'])) return false;
    if (typeof value.runId !== 'string' || !v4.test(value.runId)
      || typeof value.sessionId !== 'string' || !recordId.test(value.sessionId)
      || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || !date(value.at)) return false;
    if (value.type === 'text') {
      if (Object.hasOwn(value, 'reason') || typeof value.text !== 'string' || value.text.length > MAX_RUN_CHUNK_BYTES) return false;
      const bytes = scalarBytes(value.text);
      return bytes >= 0 && bytes <= MAX_RUN_CHUNK_BYTES;
    }
    if (Object.hasOwn(value, 'text')) return false;
    if (value.type === 'stopped' || value.type === 'failed') return !Object.hasOwn(value, 'reason')
      || stopReasons.includes(value.reason as ParticipantStopReason) && (legacySaved || !(value.type === 'stopped' && value.reason === 'paid-overflow'));
    return (value.type === 'started' || value.type === 'completed') && !Object.hasOwn(value, 'reason');
  } catch { return false; }
}

export function createConversationRun(args: CreateConversationRunArgs): ConversationRunResult {
  try {
    if (!exact(args, createKeys) || !identities(args) || !participant(args.participant) || !date(args.createdAt)) return refuse('invalid-arguments');
    const input = chunkRunText(args.input);
    if (input.kind !== 'ok') return input;
    if (input.chunks.length === 0) return refuse('invalid-text');
    const run: ConversationRun = { version: 1, runId: args.runId, sessionId: args.sessionId,
      userMessageId: args.userMessageId, assistantMessageId: args.assistantMessageId,
      participant: { ...args.participant }, inputChunks: input.chunks, outputChunks: [],
      lastSequence: 0, phase: 'prepared', createdAt: args.createdAt, updatedAt: args.createdAt };
    const serializedBytes = scalarBytes(JSON.stringify(run));
    if (serializedBytes > MAX_RUN_SERIALIZED_BYTES - MAX_RUN_CLOSURE_BYTES) return refuse('run-size-limit');
    return { kind: 'ok', run: remember(run, { inputBytes: scalarBytes(args.input), outputBytes: 0, tailBytes: 0, serializedBytes }) };
  } catch { return refuse('invalid-arguments'); }
}

/**
 * Apply a single observed event. No acknowledgement, retry, persistence or
 * transport is inferred. Unknown/terminal runs need a separate explicit
 * recovery decision; duplicate events never silently advance this reducer.
 */
export function appendParticipantEvent(run: ConversationRun, event: ParticipantEvent): ConversationRunResult {
  const captured = freezeConversationRun(run);
  if (captured.kind !== 'ok') return captured;
  run = captured.run;
  const metrics = validatedRuns.get(run)!;
  if (!validateParticipantEvent(event)) return refuse('invalid-event');
  if (event.runId !== run.runId || event.sessionId !== run.sessionId) return refuse('target-mismatch');
  if (event.sequence !== run.lastSequence + 1) return refuse('sequence-mismatch');
  if (isConversationRunClosed(run)) return refuse('invalid-transition');
  const allowed = run.phase === 'prepared' ? ['started', 'stopped', 'failed']
    : run.phase === 'running' ? ['text', 'completed', 'stopped', 'failed'] : [];
  if (!allowed.includes(event.type)) return refuse('invalid-transition');
  let output = run.outputChunks;
  let addedBytes = 0;
  let addedSerializedBytes = 0;
  let tailBytes = metrics.tailBytes;
  if (event.type === 'text') {
    addedBytes = scalarBytes(event.text);
    if (metrics.inputBytes + metrics.outputBytes + addedBytes > MAX_RUN_TEXT_BYTES) return refuse('text-limit');
    if (addedBytes > 0) {
      output = run.outputChunks.slice();
      if (!output.length) output.push('');
      let start = 0;
      for (let index = 0; index < event.text.length;) {
        const code = event.text.codePointAt(index)!;
        const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        if (tailBytes + width > MAX_RUN_CHUNK_BYTES) {
          output[output.length - 1] += event.text.slice(start, index);
          output.push(''); start = index; tailBytes = 0;
        }
        tailBytes += width;
        index += code > 0xffff ? 2 : 1;
      }
      output[output.length - 1] += event.text.slice(start);
      const newChunks = output.length - run.outputChunks.length;
      // Escaped string contents concatenate exactly for valid scalar text.
      // Each new chunk adds two quotes and (except the first) one comma.
      addedSerializedBytes = scalarBytes(JSON.stringify(event.text)) - 2 + newChunks * 3 - (run.outputChunks.length === 0 ? 1 : 0);
    }
  }
  const phase = event.type === 'started' || event.type === 'text' ? 'running' : event.type;
  const reason = event.type === 'stopped' || event.type === 'failed' ? event.reason : undefined;
  const serializedBytes = metrics.serializedBytes + addedSerializedBytes + phase.length - run.phase.length
    + String(event.sequence).length - String(run.lastSequence).length
    + (reason === undefined ? 0 : scalarBytes(JSON.stringify({ reason })) - 1);
  if (serializedBytes > MAX_RUN_SERIALIZED_BYTES - (terminalPhase(phase) ? 0 : MAX_RUN_CLOSURE_BYTES)) return refuse('run-size-limit');
  // Sequence orders evidence. This is logical record time, not a replacement
  // for the participant's event.at; a skewed clock must not wedge the stream.
  const next: ConversationRun = { ...run, outputChunks: output, lastSequence: event.sequence,
    updatedAt: run.updatedAt > event.at ? run.updatedAt : event.at, phase, ...(reason === undefined ? {} : { reason }) };
  return { kind: 'ok', run: remember(next, { inputBytes: metrics.inputBytes, outputBytes: metrics.outputBytes + addedBytes, tailBytes, serializedBytes }) };
}

/** End locally without asserting that absent events were received or that an unknown worker stopped. */
export function closeConversationRun(run: ConversationRun, closure: ConversationRunClosure): ConversationRunResult {
  const captured = freezeConversationRun(run);
  if (captured.kind !== 'ok') return captured;
  run = captured.run;
  if (isConversationRunClosed(run)) return refuse('invalid-transition');
  try {
    if (!validClosure(closure, run)) return refuse('invalid-closure');
    const copy: ConversationRunClosure = closure.kind === 'interrupted'
      ? { ...closure, terminalEvent: { ...closure.terminalEvent },
        ...(closure.reason === 'replay-lost' ? { lost: { ...closure.lost } } : {}) } : { ...closure };
    const metrics = validatedRuns.get(run)!;
    const closureBytes = scalarBytes(JSON.stringify({ closure: copy })) - 1;
    if (closureBytes > MAX_RUN_CLOSURE_BYTES) return refuse('run-size-limit');
    const serializedBytes = metrics.serializedBytes + closureBytes;
    return { kind: 'ok', run: remember({ ...run, closure: copy }, { ...metrics, serializedBytes }) };
  } catch { return refuse('invalid-closure'); }
}

/** Record only an explicit local choice after unreachable cleanup, preserving all terminal evidence.
 * The controller/UI checks reachability; this reducer grants no process authority.
 */
export function acknowledgeUnreachableCleanup(run: ConversationRun, at: string): ConversationRunResult {
  const captured = freezeConversationRun(run);
  if (captured.kind !== 'ok') return captured;
  run = captured.run;
  if (!isConversationRunClosed(run) || run.cleanupAcknowledgment) return refuse('invalid-transition');
  return freezeConversationRun({ ...run, cleanupAcknowledgment: { kind: 'unreachable', at } });
}
