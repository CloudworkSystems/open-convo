import {
  NATIVE_PARTICIPANT_OPERATIONS, isNativeParticipantOperation, participantRequestMetadata, validParticipantRunClaim,
  decodeNativeParticipantOk, type NativeParticipantMetadata, type NativeParticipantResult, type ParticipantRunClaim,
} from './native-participant-codec';
import type { ParticipantIdentity } from '../domain/conversation-run-types';
import type { DeskState } from '../domain/types';
import { validateState } from '../domain/validation';
import type {
  DecodedNativeReply, NativeDocumentContext, NativeHostCodec, NativeProofOperation, PreparedNativeRequest,
} from './native-host-client';

/** Agreed invented-data wire only; it grants no private-store or provider authority. */
export const NATIVE_PROOF_LIMITS = Object.freeze({
  recordBytes: 1_048_576, envelopeBytes: 1_114_112, textItemBytes: 65_536, outstandingMutations: 1,
} as const);
export const NATIVE_PROOF_OPERATIONS: readonly NativeProofOperation[] = Object.freeze([
  'host.capabilities', 'workspace.read', 'workspace.commitProof', 'dictation.bindDraft', 'dictation.unbindDraft',
]);
/** Reconcile and dictation receipts remain advertised-only; participant methods are issuable extensions. */
export type NativeAdvertisedOperation = NativeProofOperation | 'workspace.reconcile' | 'dictation.receipt';
const advertisedOperations: readonly NativeAdvertisedOperation[] = [
  ...NATIVE_PROOF_OPERATIONS, 'workspace.reconcile', 'dictation.receipt', ...NATIVE_PARTICIPANT_OPERATIONS,
];
const reasons = [
  'unknown-connection', 'stale-generation', 'unknown-operation', 'malformed-envelope', 'unknown-field',
  'unsupported-version', 'payload-too-large', 'text-too-large', 'payload-mismatch', 'mutation-outstanding',
  'invalid-identity', 'invalid-revision', 'revision-not-advanced', 'revision-mismatch', 'store-missing',
  'store-corrupt', 'store-locked', 'unknown-handle', 'unknown-binding', 'binding-stale', 'duplicate-delivery', 'locked',
  'unknown-delivery', 'unknown-request',
  'run-not-found', 'run-not-prepared', 'run-mismatch', 'duplicate-run', 'unknown-run',
  'participant-unavailable', 'participant-busy', 'participant-changed',
] as const;
export type NativeProofRefusal = typeof reasons[number];

type RequestFor<Operation extends NativeProofOperation, Payload> = {
  readonly requestId: string; readonly operation: Operation; readonly payload: Payload;
};
export type NativeProofRequest =
  | RequestFor<'host.capabilities', Record<string, never>>
  | RequestFor<'workspace.read', { readonly workspaceHandle: string }>
  | RequestFor<'workspace.commitProof', {
      readonly workspaceHandle: string; readonly expectedRevision: number; readonly record: DeskState;
      readonly dictationDeliveryId?: string; readonly participantRun?: ParticipantRunClaim;
    }>
  | RequestFor<'dictation.bindDraft', {
      readonly workspaceHandle: string; readonly sessionId: string; readonly expectedRevision: number;
      readonly expectedText: string; readonly selection: { readonly start: number; readonly end: number };
    }>
  | RequestFor<'dictation.unbindDraft', { readonly bindingId: string }>
  | RequestFor<'participant.availability', Record<string, never>>
  | RequestFor<'participant.start', { readonly workspaceHandle: string; readonly runId: string; readonly sessionId: string;
      readonly userMessageId: string; readonly assistantMessageId: string; readonly participant: Readonly<ParticipantIdentity>; readonly inputChunks: readonly string[] }>
  | RequestFor<'participant.stop', { readonly workspaceHandle: string; readonly runId: string; readonly sessionId: string }>
  | RequestFor<'participant.status', { readonly workspaceHandle: string; readonly runId: string; readonly sessionId: string }>
  | RequestFor<'participant.events', { readonly workspaceHandle: string; readonly runId: string; readonly sessionId: string; readonly afterSequence: number; readonly maxEvents: number }>;

export interface NativeProofCapabilities {
  readonly contractVersion: 1;
  readonly hostBuild: string;
  readonly appVersion: string;
  readonly store: 'ready' | 'missing' | 'corrupt';
  readonly lock: 'unlocked' | 'locked';
  readonly operations: readonly NativeAdvertisedOperation[];
  readonly workspaceHandle: string;
  readonly limits: typeof NATIVE_PROOF_LIMITS;
}
export type NativeProofResult =
  | NativeParticipantResult
  | { readonly operation: NativeProofOperation; readonly outcome: 'refused'; readonly reason: NativeProofRefusal }
  | { readonly operation: NativeProofOperation; readonly outcome: 'conflict'; readonly revision: number; readonly reason: 'revision-mismatch' }
  | { readonly operation: 'host.capabilities'; readonly outcome: 'ok'; readonly capabilities: NativeProofCapabilities }
  | { readonly operation: 'workspace.read'; readonly outcome: 'ok'; readonly revision: number; readonly record: DeskState }
  | { readonly operation: 'workspace.commitProof'; readonly outcome: 'ok'; readonly revision: number }
  | { readonly operation: 'dictation.bindDraft'; readonly outcome: 'ok'; readonly revision: number; readonly bindingId: string }
  | { readonly operation: 'dictation.unbindDraft'; readonly outcome: 'ok' };

type JsonObject = Record<string, unknown>;
type Metadata = NativeParticipantMetadata & {
  readonly operation: NativeProofOperation;
  readonly expectedRevision?: number;
  readonly recordRevision?: number;
};
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const uuid4 = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const recordId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const optional = (value: JsonObject, required: readonly string[], allowed: readonly string[]) => required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || allowed.includes(key));
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const text = (value: unknown): value is string => typeof value === 'string' && wellFormed(value)
  && bytes(value) <= NATIVE_PROOF_LIMITS.textItemBytes;
const opaque = (value: unknown): value is string => text(value) && value.length > 0;
const operation = (value: unknown): value is NativeProofOperation => typeof value === 'string'
  && (NATIVE_PROOF_OPERATIONS.includes(value as NativeProofOperation) || isNativeParticipantOperation(value));
const failure = () => new TypeError('The native proof request is invalid or unavailable.');

/** The existing schema remains authoritative; the proof adds byte ceilings, never truncation. */
function record(value: unknown): value is DeskState {
  if (!validateState(value).valid) return false;
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { if (!text(item)) return false; }
    else if (item !== null && typeof item === 'object') {
      if (!Array.isArray(item) && !object(item)) return false;
      if (seen.has(item)) continue;
      seen.add(item);
      pending.push(...Object.values(item));
    } else if (item !== null && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) return false;
  }
  return bytes(JSON.stringify(value)) <= NATIVE_PROOF_LIMITS.recordBytes;
}

function splitsSurrogate(value: string, at: number): boolean {
  return at > 0 && at < value.length && value.charCodeAt(at - 1) >= 0xd800 && value.charCodeAt(at - 1) <= 0xdbff
    && value.charCodeAt(at) >= 0xdc00 && value.charCodeAt(at) <= 0xdfff;
}

function metadata(request: NativeProofRequest): Metadata {
  const payload: unknown = request.payload;
  if (!object(payload)) throw failure();
  if (isNativeParticipantOperation(request.operation)) {
    const participant = participantRequestMetadata(request.operation, payload);
    if (!participant) throw failure();
    return { operation: request.operation, ...participant };
  }
  switch (request.operation) {
    case 'host.capabilities':
      if (!exact(payload, [])) throw failure();
      break;
    case 'workspace.read':
      if (!exact(payload, ['workspaceHandle']) || !opaque(payload.workspaceHandle)) throw failure();
      break;
    case 'workspace.commitProof':
      if (!optional(payload, ['workspaceHandle', 'expectedRevision', 'record'], ['dictationDeliveryId', 'participantRun']) || !opaque(payload.workspaceHandle)
        || Object.hasOwn(payload, 'dictationDeliveryId') && !uuid4(payload.dictationDeliveryId)
        || Object.hasOwn(payload, 'participantRun') && (!validParticipantRunClaim(payload.participantRun) || Object.hasOwn(payload, 'dictationDeliveryId'))
        || !integer(payload.expectedRevision) || !record(payload.record) || payload.record.revision <= payload.expectedRevision) throw failure();
      return { operation: request.operation, expectedRevision: payload.expectedRevision, recordRevision: payload.record.revision };
    case 'dictation.bindDraft': {
      if (!exact(payload, ['workspaceHandle', 'sessionId', 'expectedRevision', 'expectedText', 'selection'])
        || !opaque(payload.workspaceHandle) || !recordId(payload.sessionId) || !integer(payload.expectedRevision)
        || payload.expectedRevision === Number.MAX_SAFE_INTEGER || !text(payload.expectedText)
        || !object(payload.selection) || !exact(payload.selection, ['start', 'end'])) throw failure();
      const { start, end } = payload.selection;
      if (!integer(start) || !integer(end) || end < start || end > payload.expectedText.length
        || splitsSurrogate(payload.expectedText, start) || splitsSurrogate(payload.expectedText, end)) throw failure();
      return { operation: request.operation, expectedRevision: payload.expectedRevision };
    }
    case 'dictation.unbindDraft':
      if (!exact(payload, ['bindingId']) || !uuid4(payload.bindingId)) throw failure();
      break;
  }
  return { operation: request.operation };
}

function capabilities(value: unknown): value is NativeProofCapabilities {
  if (!object(value) || !exact(value, ['contractVersion', 'hostBuild', 'appVersion', 'store', 'lock', 'operations', 'workspaceHandle', 'limits'])
    || value.contractVersion !== 1 || !opaque(value.hostBuild) || !opaque(value.appVersion) || !opaque(value.workspaceHandle)
    || !['ready', 'missing', 'corrupt'].includes(value.store as string) || !['unlocked', 'locked'].includes(value.lock as string)
    || !Array.isArray(value.operations) || new Set(value.operations).size !== value.operations.length
    || !NATIVE_PROOF_OPERATIONS.every((required) => (value.operations as unknown[]).includes(required))
    || !value.operations.every((entry) => typeof entry === 'string' && advertisedOperations.includes(entry as NativeAdvertisedOperation))
    || !object(value.limits) || !exact(value.limits, Object.keys(NATIVE_PROOF_LIMITS))) return false;
  return Object.entries(NATIVE_PROOF_LIMITS).every(([key, limit]) => (value.limits as JsonObject)[key] === limit);
}

const replyBase = ['v', 'requestId', 'connectionId', 'generation', 'operation', 'outcome'];

/**
 * Per-document codec for the agreed v1 proof. The host still authenticates the
 * real WKWebView/frame/navigation; these IDs are correlation, not credentials.
 * This class retains only operation/revision metadata, never draft or record
 * text. prepare() is side-effect-free. register() consumes a bounded registry
 * slot only after the client accepts a new identity for dispatch. The client
 * retains exact wire bytes to refuse changed payloads and reconcile safely.
 * It calls forget() only for a returned terminal result evicted from its
 * bounded cache. Native durable deduplication governs identities beyond it.
 *
 * The native bootstrap revokes this codec together with NativeHostClient.
 * The participant extension validates evidence only; it grants no dispatch authority.
 */
export class NativeProofCodec implements NativeHostCodec<NativeProofRequest, NativeProofResult> {
  private readonly context: NativeDocumentContext;
  private readonly requests = new Map<string, Metadata>();
  private active = true;

  constructor(context: NativeDocumentContext, private readonly maxRetainedRequests: number) {
    if (!opaque(context.connectionId) || !integer(context.documentGeneration)
      || !Number.isSafeInteger(maxRetainedRequests) || maxRetainedRequests < 1) throw failure();
    this.context = Object.freeze({ connectionId: context.connectionId, documentGeneration: context.documentGeneration });
  }

  prepare(context: NativeDocumentContext, request: NativeProofRequest): PreparedNativeRequest {
    try {
      if (!this.active || context.connectionId !== this.context.connectionId || context.documentGeneration !== this.context.documentGeneration) throw failure();
      // Also make direct codec callers independent of later caller mutation.
      const captured: unknown = structuredClone(request);
      if (!object(captured) || !exact(captured, ['requestId', 'operation', 'payload']) || !uuid4(captured.requestId)
        || !operation(captured.operation)) throw failure();
      const details = metadata(captured as NativeProofRequest);
      const previous = this.requests.get(captured.requestId);
      if (previous && (previous.operation !== details.operation || previous.expectedRevision !== details.expectedRevision
        || previous.recordRevision !== details.recordRevision || previous.runId !== details.runId
        || previous.sessionId !== details.sessionId || previous.afterSequence !== details.afterSequence || previous.maxEvents !== details.maxEvents)) throw failure();
      const wire = JSON.stringify({ v: 1, requestId: captured.requestId, connectionId: this.context.connectionId,
        generation: this.context.documentGeneration, operation: captured.operation, payload: captured.payload });
      if (bytes(wire) > NATIVE_PROOF_LIMITS.envelopeBytes) throw failure();
      return Object.freeze({ requestId: captured.requestId, operation: captured.operation, wire });
    } catch { throw failure(); }
  }

  register(prepared: PreparedNativeRequest): void {
    try {
      if (!this.active || !object(prepared) || !exact(prepared, ['requestId', 'operation', 'wire'])
        || !uuid4(prepared.requestId) || !operation(prepared.operation) || typeof prepared.wire !== 'string'
        || bytes(prepared.wire) > NATIVE_PROOF_LIMITS.envelopeBytes) throw failure();
      const envelope: unknown = JSON.parse(prepared.wire);
      if (!object(envelope) || !exact(envelope, ['v', 'requestId', 'connectionId', 'generation', 'operation', 'payload'])
        || envelope.v !== 1 || envelope.requestId !== prepared.requestId || envelope.operation !== prepared.operation
        || envelope.connectionId !== this.context.connectionId || envelope.generation !== this.context.documentGeneration) throw failure();
      const details = metadata({ requestId: prepared.requestId, operation: prepared.operation, payload: envelope.payload } as NativeProofRequest);
      const previous = this.requests.get(prepared.requestId);
      if (previous && (previous.operation !== details.operation || previous.expectedRevision !== details.expectedRevision
        || previous.recordRevision !== details.recordRevision || previous.runId !== details.runId
        || previous.sessionId !== details.sessionId || previous.afterSequence !== details.afterSequence || previous.maxEvents !== details.maxEvents)) throw failure();
      if (!previous && this.requests.size >= this.maxRetainedRequests) throw failure();
      if (!previous) this.requests.set(prepared.requestId, Object.freeze(details));
    } catch { throw failure(); }
  }

  revoke(): void {
    this.active = false;
    this.requests.clear();
  }

  /** Lifecycle-owned eviction; pending and workspace-unresolved identities stay pinned. */
  forget(requestId: string): void {
    this.requests.delete(requestId);
  }

  decode(wire: string): DecodedNativeReply<NativeProofResult> | undefined {
    if (!this.active || typeof wire !== 'string' || bytes(wire) > NATIVE_PROOF_LIMITS.envelopeBytes) return undefined;
    try {
      const reply: unknown = JSON.parse(wire);
      if (!object(reply) || reply.v !== 1 || !uuid4(reply.requestId) || reply.connectionId !== this.context.connectionId
        || reply.generation !== this.context.documentGeneration || !operation(reply.operation)) return undefined;
      const expected = this.requests.get(reply.requestId);
      if (!expected || expected.operation !== reply.operation) return undefined;
      let result: NativeProofResult;
      if (reply.outcome === 'unknown') {
        if (!exact(reply, replyBase)) return undefined;
        // Participant uncertainty settles this read/control lane; workspace uncertainty still retains its barrier.
        if (!isNativeParticipantOperation(reply.operation) || reply.operation === 'participant.status') return undefined;
        result = { operation: reply.operation, outcome: 'unknown' };
      } else if (reply.outcome === 'refused') {
        if (!exact(reply, [...replyBase, 'reason']) || !reasons.includes(reply.reason as NativeProofRefusal)) return undefined;
        result = { operation: reply.operation, outcome: 'refused', reason: reply.reason as NativeProofRefusal };
      } else if (reply.outcome === 'conflict') {
        if (isNativeParticipantOperation(reply.operation) || !exact(reply, [...replyBase, 'reason', 'revision']) || reply.reason !== 'revision-mismatch' || !integer(reply.revision)) return undefined;
        result = { operation: reply.operation, outcome: 'conflict', revision: reply.revision, reason: 'revision-mismatch' };
      } else if (reply.outcome === 'ok') {
        if (isNativeParticipantOperation(reply.operation)) {
          const participant = decodeNativeParticipantOk(reply, expected);
          if (!participant) return undefined;
          result = participant;
        } else switch (reply.operation) {
          case 'host.capabilities':
            if (!exact(reply, [...replyBase, 'capabilities']) || !capabilities(reply.capabilities)) return undefined;
            result = { operation: reply.operation, outcome: 'ok', capabilities: reply.capabilities };
            break;
          case 'workspace.read':
            if (!exact(reply, [...replyBase, 'revision', 'record']) || !integer(reply.revision)
              || !record(reply.record) || reply.record.revision !== reply.revision) return undefined;
            result = { operation: reply.operation, outcome: 'ok', revision: reply.revision, record: reply.record };
            break;
          case 'workspace.commitProof':
            if (!exact(reply, [...replyBase, 'revision']) || !integer(reply.revision) || reply.revision !== expected.recordRevision) return undefined;
            result = { operation: reply.operation, outcome: 'ok', revision: reply.revision };
            break;
          case 'dictation.bindDraft':
            if (!exact(reply, [...replyBase, 'revision', 'bindingId']) || reply.revision !== expected.expectedRevision || !uuid4(reply.bindingId)) return undefined;
            result = { operation: reply.operation, outcome: 'ok', revision: reply.revision as number, bindingId: reply.bindingId };
            break;
          case 'dictation.unbindDraft':
            if (!exact(reply, replyBase)) return undefined;
            result = { operation: reply.operation, outcome: 'ok' };
            break;
        }
      } else return undefined;
      return { requestId: reply.requestId, connectionId: this.context.connectionId,
        documentGeneration: this.context.documentGeneration, operation: reply.operation, result };
    } catch { return undefined; }
  }
}
