import type { ParticipantIdentity } from '../domain/conversation-run-types';
import type { NativeDocumentContext } from './native-host-client';

export const NATIVE_PARTICIPANT_OPERATIONS = Object.freeze([
  'participant.availability', 'participant.start', 'participant.stop', 'participant.status', 'participant.events',
] as const);
export type NativeParticipantOperation = typeof NATIVE_PARTICIPANT_OPERATIONS[number];
export type NativeParticipantConfirmation =
  | { readonly state: 'unconfirmed' }
  | { readonly state: 'active'; readonly confirmedAt: string; readonly runsLeft: number }
  | { readonly state: 'ended'; readonly endedBy: 'lock' | 'sleep' | 'logout' | 'cli-changed' | 'login-changed' | 'run-limit' | 'paid-overflow' };
export type NativeParticipantAvailabilityReason = 'cli-missing' | 'cli-version-mismatch' | 'provider-override'
  | 'signed-out' | 'not-subscription' | 'overflow-unverified' | 'check-failed';
export interface NativeParticipantAvailability extends Readonly<ParticipantIdentity> {
  readonly available: boolean;
  readonly reason: NativeParticipantAvailabilityReason | null;
  readonly confirmation?: NativeParticipantConfirmation;
}
/** Contract section 20.2: one local chat model; `model` is its name, `@` and its 64-hex digest. */
export interface NativeLocalParticipantAvailability extends Readonly<ParticipantIdentity> {
  readonly available: boolean;
  readonly reason: 'model-not-local' | null;
}
export type NativeParticipantRouteReason = 'ollama-not-running' | 'catalog-unreadable' | 'host-not-loopback';
export interface NativeParticipantRoute {
  readonly route: 'ollama-local';
  readonly state: 'ready' | 'unavailable';
  readonly reason: NativeParticipantRouteReason | null;
}
export interface ParticipantRunClaim {
  readonly runId: string; readonly sessionId: string; readonly userMessageId: string; readonly assistantMessageId: string;
  readonly participantId: string; readonly createdAt: string;
}
export type NativeParticipantEvent = {
  readonly runId: string; readonly sessionId: string; readonly sequence: number; readonly at: string;
} & (
  | { readonly type: 'started' }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'completed' }
  | { readonly type: 'stopped'; readonly reason: 'local-stop' | 'stop-incomplete' }
  | { readonly type: 'failed'; readonly reason: 'reply-too-long' | 'paid-overflow' | 'timeout' | 'process-error' }
);
export type NativeParticipantTerminalEvent = Extract<NativeParticipantEvent, { type: 'completed' | 'stopped' | 'failed' }>;
export interface NativeParticipantLost {
  readonly fromSequence: number; readonly throughSequence: number | null;
  readonly reason: 'locked' | 'closed' | 'restarted' | 'replaced';
}
export type NativeParticipantResult =
  | { readonly operation: Exclude<NativeParticipantOperation, 'participant.status'>; readonly outcome: 'unknown' }
  | { readonly operation: 'participant.availability'; readonly outcome: 'ok';
      /** The Claude Code entry first (section 5), then local chat models (section 20.2). */
      readonly participants: readonly [NativeParticipantAvailability, ...NativeLocalParticipantAvailability[]];
      /** Present only on a host with a local route (contract section 20.2). */
      readonly routes?: readonly NativeParticipantRoute[] }
  | { readonly operation: 'participant.start'; readonly outcome: 'ok'; readonly runId: string }
  | { readonly operation: 'participant.stop'; readonly outcome: 'ok'; readonly runId: string;
      readonly state: 'exited' | 'cleanup-pending' | 'not-owned'; readonly terminal: NativeParticipantTerminalEvent | null;
      readonly groupCleared: boolean | null; readonly providerCancelConfirmed: false }
  | { readonly operation: 'participant.status'; readonly outcome: 'ok'; readonly runId: string;
      readonly state: 'not-dispatched' | 'starting' | 'running' | 'stopping' | 'cleanup-pending' | 'exited' | 'unknown';
      readonly lastSequence: number | null; readonly terminal: NativeParticipantTerminalEvent | null;
      readonly groupCleared: boolean | null; readonly unknownReason: 'store-unreadable' | 'start-uncertain' | 'exit-unrecorded' | null }
  | { readonly operation: 'participant.events'; readonly outcome: 'ok'; readonly runId: string;
      readonly events: readonly NativeParticipantEvent[]; readonly more: boolean; readonly lastSequence: number | null;
      readonly lost: NativeParticipantLost | null; readonly terminal: NativeParticipantTerminalEvent | null };
export interface NativeParticipantMetadata {
  readonly runId?: string; readonly sessionId?: string; readonly afterSequence?: number; readonly maxEvents?: number;
}
type Obj = Record<string, unknown>;
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: Obj, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const uuid4 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const recordId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const validText = (v: unknown, limit: number, nonblank = false): v is string => typeof v === 'string'
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)
  && v.length > 0 && bytes(v) <= limit && (!nonblank || v.trim().length > 0);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const identities = (v: Obj, messageIds: boolean) => uuid4(v.runId) && recordId(v.sessionId)
  && (!messageIds || uuid4(v.userMessageId) && uuid4(v.assistantMessageId))
  && new Set((messageIds ? [v.runId, v.sessionId, v.userMessageId, v.assistantMessageId] : [v.runId, v.sessionId])
    .map(id => (id as string).toLowerCase())).size === (messageIds ? 4 : 2);
const pin = (v: unknown): v is ParticipantIdentity => object(v) && exact(v, ['id', 'label', 'model', 'executionHost'])
  && Object.values(v).every(item => validText(item, 256, true));
const availabilityReasons = ['cli-missing', 'cli-version-mismatch', 'provider-override', 'signed-out', 'not-subscription', 'overflow-unverified', 'check-failed'];

export function isNativeParticipantOperation(value: unknown): value is NativeParticipantOperation {
  return typeof value === 'string' && NATIVE_PARTICIPANT_OPERATIONS.includes(value as NativeParticipantOperation);
}
export function validParticipantRunClaim(value: unknown): value is ParticipantRunClaim {
  return object(value) && exact(value, ['runId', 'sessionId', 'userMessageId', 'assistantMessageId', 'participantId', 'createdAt'])
    && identities(value, true) && validText(value.participantId, 256, true) && timestamp(value.createdAt);
}
export function participantRequestMetadata(operation: NativeParticipantOperation, value: unknown): NativeParticipantMetadata | undefined {
  if (!object(value)) return undefined;
  if (operation === 'participant.availability') return exact(value, []) ? {} : undefined;
  const base = ['workspaceHandle', 'runId', 'sessionId'];
  const keys = operation === 'participant.start' ? [...base, 'userMessageId', 'assistantMessageId', 'participant', 'inputChunks']
    : operation === 'participant.events' ? [...base, 'afterSequence', 'maxEvents'] : base;
  if (!exact(value, keys) || !validText(value.workspaceHandle, 65_536) || !identities(value, operation === 'participant.start')) return undefined;
  if (operation === 'participant.start' && (!pin(value.participant) || !Array.isArray(value.inputChunks) || value.inputChunks.length === 0
    || !value.inputChunks.every(chunk => validText(chunk, 16_384))
    || value.inputChunks.reduce((total: number, chunk: string) => total + bytes(chunk), 0) > 262_144)) return undefined;
  if (operation === 'participant.events' && (!integer(value.afterSequence) || !integer(value.maxEvents)
    || value.maxEvents < 1 || value.maxEvents > 64)) return undefined;
  return { runId: value.runId as string, sessionId: value.sessionId as string,
    ...(operation === 'participant.events' ? { afterSequence: value.afterSequence as number, maxEvents: value.maxEvents as number } : {}) };
}
function confirmation(value: unknown): value is NativeParticipantConfirmation {
  if (!object(value)) return false;
  switch (value.state) {
    case 'unconfirmed': return exact(value, ['state']);
    case 'active': return exact(value, ['state', 'confirmedAt', 'runsLeft']) && timestamp(value.confirmedAt)
      && integer(value.runsLeft) && value.runsLeft >= 1 && value.runsLeft <= 5;
    case 'ended': return exact(value, ['state', 'endedBy'])
      && ['lock', 'sleep', 'logout', 'cli-changed', 'login-changed', 'run-limit', 'paid-overflow'].includes(value.endedBy as string);
    default: return false;
  }
}
function availability(value: unknown): value is NativeParticipantAvailability {
  if (!object(value) || !exact(value, ['id', 'label', 'model', 'executionHost', 'available', 'reason',
    ...(Object.hasOwn(value, 'confirmation') ? ['confirmation'] : [])]) || value.id !== 'claude-code'
    || !pin({ id: value.id, label: value.label, model: value.model, executionHost: value.executionHost })
    || typeof value.available !== 'boolean' || (value.available ? value.reason !== null : !availabilityReasons.includes(value.reason as string))) return false;
  if (!Object.hasOwn(value, 'confirmation')) return true;
  if (!confirmation(value.confirmation)) return false;
  // Earlier checks may fail despite an active confirmation, but its own check cannot.
  return value.confirmation.state === 'active' ? value.reason !== 'overflow-unverified' : !value.available;
}
const localModel = /^(.+)@([0-9a-f]{64})$/s;
function localAvailability(value: unknown): value is NativeLocalParticipantAvailability {
  if (!object(value) || !exact(value, ['id', 'label', 'model', 'executionHost', 'available', 'reason'])
    || value.id !== 'ollama-local' || value.executionHost !== 'this-mac'
    || !pin({ id: value.id, label: value.label, model: value.model, executionHost: value.executionHost })) return false;
  const match = localModel.exec(value.model as string);
  return match !== null && match[1] === value.label && typeof value.available === 'boolean'
    && (value.available ? value.reason === null : value.reason === 'model-not-local');
}
function route(value: unknown): value is NativeParticipantRoute {
  return object(value) && exact(value, ['route', 'state', 'reason']) && value.route === 'ollama-local'
    && (value.state === 'ready' ? value.reason === null
      : value.state === 'unavailable' && ['ollama-not-running', 'catalog-unreadable', 'host-not-loopback'].includes(value.reason as string));
}
/** Code-point order, not UTF-16 unit order (section 20.2). */
function codePointBefore(a: string, b: string): boolean {
  const x = Array.from(a, c => c.codePointAt(0)!), y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i];
  return x.length < y.length;
}
function event(value: unknown, target?: NativeParticipantMetadata): value is NativeParticipantEvent {
  if (!object(value) || !identities(value, false) || !integer(value.sequence) || value.sequence < 1 || !timestamp(value.at)
    || target?.runId !== undefined && value.runId !== target.runId || target?.sessionId !== undefined && value.sessionId !== target.sessionId) return false;
  const base = ['runId', 'sessionId', 'sequence', 'at', 'type'];
  switch (value.type) {
    case 'started': return exact(value, base) && value.sequence === 1;
    case 'text': return exact(value, [...base, 'text']) && value.sequence > 1 && validText(value.text, 16_384);
    case 'completed': return exact(value, base) && value.sequence > 1;
    case 'stopped': return exact(value, [...base, 'reason']) && ['local-stop', 'stop-incomplete'].includes(value.reason as string);
    case 'failed': return exact(value, [...base, 'reason']) && ['reply-too-long', 'paid-overflow', 'timeout', 'process-error'].includes(value.reason as string);
    default: return false;
  }
}
const terminal = (v: unknown, target: NativeParticipantMetadata): v is NativeParticipantTerminalEvent => event(v, target)
  && ['completed', 'stopped', 'failed'].includes(v.type);
const baseReply = ['v', 'requestId', 'connectionId', 'generation', 'operation', 'outcome'];
/** Called after envelope/identity correlation by NativeProofCodec. */
export function decodeNativeParticipantOk(reply: Obj, expected: NativeParticipantMetadata): NativeParticipantResult | undefined {
  if (reply.operation === 'participant.availability') {
    if (!Object.hasOwn(reply, 'routes')) {
      if (!exact(reply, [...baseReply, 'participants']) || !Array.isArray(reply.participants)
        || reply.participants.length !== 1 || !reply.participants.every(availability)) return undefined;
      return { operation: reply.operation, outcome: 'ok', participants: reply.participants as [NativeParticipantAvailability] };
    }
    // Section 20.2: the Claude Code entry first, then local chat models by name.
    if (!exact(reply, [...baseReply, 'participants', 'routes']) || !Array.isArray(reply.participants)
      || !Array.isArray(reply.routes) || reply.routes.length !== 1 || !route(reply.routes[0])
      || reply.participants.length < 1 || reply.participants.length > 65 || !availability(reply.participants[0])) return undefined;
    const local = reply.participants.slice(1);
    if (!local.every(localAvailability) || reply.routes[0].state === 'unavailable' && local.length > 0
      || local.some((entry, i) => i > 0 && !codePointBefore(local[i - 1].label, entry.label))) return undefined;
    return { operation: reply.operation, outcome: 'ok',
      participants: reply.participants as [NativeParticipantAvailability, ...NativeLocalParticipantAvailability[]], routes: reply.routes };
  }
  if (reply.runId !== expected.runId) return undefined;
  if (reply.operation === 'participant.start') return exact(reply, [...baseReply, 'runId'])
    ? { operation: reply.operation, outcome: 'ok', runId: expected.runId! } : undefined;
  if (reply.operation === 'participant.status' || reply.operation === 'participant.stop') {
    const status = reply.operation === 'participant.status';
    const fields = status ? ['runId', 'state', 'lastSequence', 'terminal', 'groupCleared', 'unknownReason']
      : ['runId', 'state', 'terminal', 'groupCleared', 'providerCancelConfirmed'];
    if (!exact(reply, [...baseReply, ...fields]) || !(reply.groupCleared === null || typeof reply.groupCleared === 'boolean')
      || !(reply.terminal === null || terminal(reply.terminal, expected))) return undefined;
    if (reply.terminal !== null && (reply.groupCleared === null && (reply.terminal.sequence !== 1 || reply.terminal.type === 'completed'
      || reply.terminal.type === 'stopped' && reply.terminal.reason === 'stop-incomplete')
      || reply.groupCleared === false && reply.terminal.type === 'stopped' && reply.terminal.reason === 'local-stop')) return undefined;
    if (status) {
      if (!(reply.lastSequence === null || integer(reply.lastSequence))) return undefined;
      if (reply.state === 'unknown') {
        if (!['store-unreadable', 'start-uncertain', 'exit-unrecorded'].includes(reply.unknownReason as string)
          || reply.terminal !== null || reply.groupCleared !== null) return undefined;
        if (reply.unknownReason === 'exit-unrecorded' && reply.lastSequence !== null) return undefined;
      } else {
        if (reply.unknownReason !== null || !integer(reply.lastSequence)) return undefined;
        if (['not-dispatched', 'starting', 'running', 'stopping'].includes(reply.state as string)) {
          if (reply.terminal !== null || reply.groupCleared !== null
            || ['not-dispatched', 'starting'].includes(reply.state as string) && reply.lastSequence !== 0) return undefined;
        } else if (reply.state === 'exited' || reply.state === 'cleanup-pending') {
          if (!terminal(reply.terminal, expected) || reply.lastSequence !== reply.terminal.sequence
            || reply.state === 'cleanup-pending' && reply.groupCleared !== false) return undefined;
        } else return undefined;
      }
    } else {
      if (reply.providerCancelConfirmed !== false) return undefined;
      if (reply.state === 'not-owned') {
        if (reply.terminal !== null || reply.groupCleared !== null) return undefined;
      } else if (reply.state === 'exited' || reply.state === 'cleanup-pending') {
        if (!terminal(reply.terminal, expected) || reply.state === 'cleanup-pending' && reply.groupCleared !== false) return undefined;
      } else return undefined;
    }
    const { v: _v, requestId: _id, connectionId: _connection, generation: _generation, ...result } = reply;
    return result as NativeParticipantResult;
  }
  if (reply.operation === 'participant.events') {
    if (!exact(reply, [...baseReply, 'runId', 'events', 'more', 'lastSequence', 'lost', 'terminal'])
      || !Array.isArray(reply.events) || reply.events.length > expected.maxEvents! || typeof reply.more !== 'boolean'
      || !(reply.lastSequence === null || integer(reply.lastSequence))) return undefined;
    const after = expected.afterSequence!;
    // Section 13 treats a page ahead of native's known high-water mark as inconsistent evidence.
    if (reply.lastSequence !== null && after > reply.lastSequence) return undefined;
    if (reply.lost !== null) {
      if (!object(reply.lost) || !exact(reply.lost, ['fromSequence', 'throughSequence', 'reason'])
        || !integer(reply.lost.fromSequence) || reply.lost.fromSequence !== after + 1
        || !(reply.lost.throughSequence === null || integer(reply.lost.throughSequence) && reply.lost.throughSequence >= reply.lost.fromSequence)
        || !['locked', 'closed', 'restarted', 'replaced'].includes(reply.lost.reason as string)
        || reply.events.length !== 0 || reply.more !== false) return undefined;
      if (reply.terminal !== null) {
        if (!terminal(reply.terminal, expected) || reply.lost.throughSequence !== reply.terminal.sequence - 1
          || reply.lastSequence !== reply.terminal.sequence) return undefined;
      } else if (reply.lost.throughSequence !== null) return undefined;
    } else {
      if (reply.terminal !== null || reply.lastSequence === null && (reply.events.length > 0 || reply.more)) return undefined;
      for (let i = 0; i < reply.events.length; i++) {
        const item = reply.events[i];
        if (!event(item, expected) || item.sequence !== after + i + 1
          || i > 0 && (item.at < reply.events[i - 1].at || terminal(reply.events[i - 1], expected))) return undefined;
      }
      const last = reply.events.length ? reply.events[reply.events.length - 1].sequence : after;
      if (reply.lastSequence !== null && (reply.events.length > 0 && last > reply.lastSequence
        || reply.more !== (last < reply.lastSequence) || reply.events.length === 0 && after < reply.lastSequence)) return undefined;
      if (reply.events.length && terminal(reply.events[reply.events.length - 1], expected) && reply.more) return undefined;
    }
    if (bytes(JSON.stringify(reply)) > 1_048_576) return undefined;
    const { v: _v, requestId: _id, connectionId: _connection, generation: _generation, ...result } = reply;
    return result as NativeParticipantResult;
  }
  return undefined;
}

function capturePush(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!object(value) || depth > 2) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured: Obj = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
    Object.defineProperty(captured, key, { value: capturePush(descriptor.value, depth + 1), enumerable: true });
  }
  return captured;
}

/** Pushes carry no request id; their document and complete inner event are checked first. */
export function decodeNativeParticipantPush(context: NativeDocumentContext, detail: unknown): NativeParticipantEvent | undefined {
  try {
    const captured = capturePush(detail);
    if (!object(captured) || !exact(captured, ['type', 'connectionId', 'generation', 'event'])
      || captured.type !== 'participant.event' || captured.connectionId !== context.connectionId
      || captured.generation !== context.documentGeneration || !event(captured.event)) return undefined;
    return Object.freeze(captured.event);
  } catch { return undefined; }
}
