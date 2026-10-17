import type { ParticipantEvent, ParticipantIdentity } from '../domain/conversation-run-types';
import { sameParticipantIdentity, validParticipantIdentity } from '../domain/participant-choices';
import type { NativeDocumentContext, NativeHostClient, NativeRequestOutcome } from './native-host-client';
import type { NativeProofRequest, NativeProofResult } from './native-host-codec';
import { decodeNativeParticipantPush, type NativeLocalParticipantAvailability, type NativeParticipantAvailability,
  type NativeParticipantRoute } from './native-participant-codec';
import { isLocalParticipant, MAX_LOCAL_CONTEXT_BYTES } from '../domain/local-participant';
import type { ParticipantPort, ParticipantReconcileResult, ParticipantStartInput, ParticipantStartResult,
  ParticipantStatusResult, ParticipantStopResult, ParticipantTarget } from './participant-runtime';
import type { WKHostEvents } from './wk-host-transport';

export const NATIVE_PARTICIPANT_INPUT_BYTES = 4096;
const MAX_REPLAY_PAGES = 64;
const MAX_REPLAY_TEXT_BYTES = 262_144;
const MAX_REPLAY_BYTES = 1_048_576;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The first trial keeps the entire draft; it never truncates or splits a call. */
export function nativeParticipantInputWithinLimit(chunks: readonly string[]): boolean {
  if (!Array.isArray(chunks) || !chunks.length) return false;
  let size = 0;
  for (const chunk of chunks) {
    if (typeof chunk !== 'string' || !chunk.length
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk)) return false;
    size += bytes(chunk);
    if (size > NATIVE_PARTICIPANT_INPUT_BYTES) return false;
  }
  return true;
}

/** Section 20.3: a local run's one input limit (context is counted by the page before preparing). */
export function localParticipantInputWithinLimit(chunks: readonly string[]): boolean {
  if (!Array.isArray(chunks) || !chunks.length) return false;
  let size = 0;
  for (const chunk of chunks) {
    if (typeof chunk !== 'string' || !chunk.length
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk)) return false;
    size += bytes(chunk);
    if (size > MAX_LOCAL_CONTEXT_BYTES) return false;
  }
  return true;
}

export interface NativeParticipantSnapshot {
  /** Last decoded pin for display/recovery only; consult available, checking and error for current usability. */
  readonly entry: NativeParticipantAvailability | null;
  /** Local chat models from the same reply (section 20.2), by name. Empty without a ready route. */
  readonly local: readonly NativeLocalParticipantAvailability[];
  /** The local route's state, or null on a host without one (revision 3). */
  readonly route: NativeParticipantRoute | null;
  /**
   * Whether any reply on this connection carried a local route: a host that
   * offers local models, even while a later read failed or is outstanding.
   * Display only: it never makes anything available.
   */
  readonly offersLocal: boolean;
  readonly available: boolean;
  /** Whether the newest availability read is outstanding; older reads cannot clear this. */
  readonly checking: boolean;
  readonly error: string | null;
}
export interface NativeParticipantConnectionOptions {
  /** A separate bounded client: participant requests never share a save barrier. */
  readonly client: NativeHostClient<NativeProofRequest, NativeProofResult>;
  readonly context: NativeDocumentContext;
  readonly workspaceHandle: string;
  readonly events: WKHostEvents;
  readonly requestId: () => string;
  readonly onRevoked?: () => void;
}
interface FreshAvailability {
  readonly entry: NativeParticipantAvailability;
  readonly local: readonly NativeLocalParticipantAvailability[];
  readonly route: NativeParticipantRoute | null;
}
type LocalRefusal = { kind: 'not-started'; reason: 'participant-changed' | 'participant-unavailable'; retryable: boolean };
/** Null when this exact local model may be asked now; otherwise the refusal, with nothing sent. */
function localDecision(identity: Readonly<ParticipantIdentity>, fresh: FreshAvailability): LocalRefusal | null {
  if (!fresh.route || fresh.route.state !== 'ready') return { kind: 'not-started', reason: 'participant-unavailable', retryable: true };
  const exact = fresh.local.find((entry) => sameParticipantIdentity(identity, entry));
  if (exact) return exact.available ? null : { kind: 'not-started', reason: 'participant-unavailable', retryable: false };
  // Section 20.4: a ready route with no entry for this exact name and digest
  // is a change (moved tag or removed model), never a passing outage.
  return { kind: 'not-started', reason: 'participant-changed', retryable: false };
}
const ambiguousStart = new Set(['duplicate-run', 'payload-mismatch', 'store-corrupt', 'store-missing']);
const retryableStart = new Set(['participant-busy', 'participant-unavailable', 'store-locked', 'unknown-connection', 'stale-generation']);
const knownLock = new Set(['store-locked', 'locked']);
type WithoutRequestId<Request> = Request extends { requestId: string } ? Omit<Request, 'requestId'> : never;

/** No polling, provider selection, persistence, dispatch retry or native authority lives here. */
export class NativeParticipantConnection {
  private active = true;
  private attached = false;
  private availabilityAttempt = 0;
  private checking = false;
  private entry: NativeParticipantAvailability | null = null;
  private local: readonly NativeLocalParticipantAvailability[] = Object.freeze([]);
  private route: NativeParticipantRoute | null = null;
  private offersLocal = false;
  private error: string | null = null;
  private readonly changed = new Set<() => void>();
  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly context: NativeDocumentContext;

  constructor(private readonly options: NativeParticipantConnectionOptions) {
    this.context = Object.freeze({ ...options.context });
    this.attached = true;
    try { options.events.addEventListener('trueconvo-host', this.receive); }
    catch { this.revoke(); }
  }

  get snapshot(): NativeParticipantSnapshot {
    return Object.freeze({ entry: this.entry, local: this.local, route: this.route, offersLocal: this.offersLocal,
      available: this.active && !this.checking && this.error === null && this.entry?.available === true,
      checking: this.checking, error: this.error });
  }
  subscribeChanges(listener: () => void): () => void {
    if (this.active) this.changed.add(listener);
    return () => { this.changed.delete(listener); };
  }
  async refreshAvailability(): Promise<void> {
    await this.readAvailability();
  }
  private async readAvailability(): Promise<FreshAvailability | null> {
    if (!this.active) return null;
    const attempt = ++this.availabilityAttempt;
    this.checking = true;
    this.publish();
    const outcome = await this.request({ operation: 'participant.availability', payload: {} });
    if (!this.active) return null;
    const result = outcome.kind === 'completed' ? outcome.result : null;
    const fresh: FreshAvailability | null = result?.operation === 'participant.availability' && result.outcome === 'ok'
      ? Object.freeze({ entry: result.participants[0], local: Object.freeze(result.participants.slice(1) as NativeLocalParticipantAvailability[]),
        route: result.routes?.[0] ?? null }) : null;
    if (attempt === this.availabilityAttempt) {
      this.checking = false;
      if (fresh) {
        this.entry = fresh.entry;
        this.local = fresh.local;
        this.route = fresh.route;
        if (fresh.route) this.offersLocal = true;
        this.error = null;
      } else {
        // Retain a known identity without granting stale availability. A failed
        // check says nothing about whether that saved participant is approved.
        // The local catalog is dropped, not kept: an older reply is no evidence
        // that a model is still local, so every Ollama title turns neutral
        // until a later read succeeds (section 20.2).
        this.local = Object.freeze([]);
        this.route = null;
        this.error = outcome.kind !== 'completed' ? outcome.reason
          : result?.outcome === 'refused' ? result.reason : 'check-failed';
      }
      this.publish();
    }
    // Latest-wins applies only to the picker. Each Start uses its own fresh
    // response even if an unrelated display refresh began in the meantime.
    return fresh;
  }

  portFor(identity: Readonly<ParticipantIdentity>): ParticipantPort {
    if (!validParticipantIdentity(identity)) throw new TypeError('The native participant identity is invalid.');
    const pinned = Object.freeze({ ...identity });
    return Object.freeze({
      identity: pinned,
      canStart: () => this.canStart(pinned),
      subscribe: (listener: (event: unknown) => void) => {
        if (this.active) this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
      start: (input: ParticipantStartInput, mayDispatch?: (evidence?: { availabilityConfirmed: true }) => boolean) => this.start(pinned, input, mayDispatch),
      stop: (target: ParticipantTarget) => this.stop(target),
      status: (target: ParticipantTarget) => this.status(target),
      reconcile: (target: ParticipantTarget & { readonly afterSequence: number }) => this.reconcile(target),
    });
  }

  dispose(): void { this.revoke(false); }

  private canStart(identity: Readonly<ParticipantIdentity>): boolean {
    if (!this.active || this.error !== null) return false;
    if (isLocalParticipant(identity)) return localDecision(identity, { entry: this.entry!, local: this.local, route: this.route }) === null;
    return this.entry?.available === true && sameParticipantIdentity(identity, this.entry);
  }
  private async start(identity: Readonly<ParticipantIdentity>, input: ParticipantStartInput, mayDispatch?: (evidence?: { availabilityConfirmed: true }) => boolean): Promise<ParticipantStartResult> {
    if (!this.active) return { kind: 'not-started', reason: 'stale-generation', retryable: true };
    if (!sameParticipantIdentity(identity, input.participant)) return { kind: 'not-started', reason: 'run-mismatch', retryable: false };
    const local = isLocalParticipant(identity);
    if (!(local ? localParticipantInputWithinLimit(input.inputChunks) : nativeParticipantInputWithinLimit(input.inputChunks))) {
      return { kind: 'not-started', reason: 'text-too-large', retryable: false };
    }
    // Snapshot before the async check; no caller mutation can change a prepared identity or input.
    const payload = { workspaceHandle: this.options.workspaceHandle, runId: input.runId, sessionId: input.sessionId,
      userMessageId: input.userMessageId, assistantMessageId: input.assistantMessageId,
      participant: identity, inputChunks: [...input.inputChunks] };
    const fresh = await this.readAvailability();
    if (!this.active) return { kind: 'not-started', reason: 'stale-generation', retryable: true };
    if (local) {
      // Section 20.2/20.4: only the exact name and digest, available in a ready
      // route. Never another model, and never the Claude entry instead.
      if (!fresh) return { kind: 'not-started', reason: 'participant-unavailable', retryable: true };
      const refusal = localDecision(identity, fresh);
      if (refusal) return refusal;
    } else {
      if (fresh && !sameParticipantIdentity(identity, fresh.entry)) return { kind: 'not-started', reason: 'participant-changed', retryable: false };
      if (!fresh || !fresh.entry.available) return { kind: 'not-started', reason: 'participant-unavailable', retryable: true };
    }
    // Another run can acquire an unsaved tail during the native availability
    // check. Re-read the controller's current save/Stop latches just before the
    // synchronous request dispatch; a throwing predicate grants no permission.
    let permitted = mayDispatch === undefined;
    try { if (mayDispatch) permitted = mayDispatch({ availabilityConfirmed: true }) === true; } catch { /* Fail closed. */ }
    if (!permitted) return { kind: 'not-started', reason: 'workspace-not-ready', retryable: true };
    const outcome = await this.request({ operation: 'participant.start', payload });
    if (outcome.kind !== 'completed') return { kind: 'unknown' };
    const result = outcome.result;
    if (result.operation !== 'participant.start') return { kind: 'unknown' };
    if (result.outcome === 'ok') return { kind: 'accepted' };
    if (result.outcome !== 'refused' || ambiguousStart.has(result.reason)) return { kind: 'unknown' };
    return { kind: 'not-started', reason: result.reason, retryable: retryableStart.has(result.reason) };
  }

  private async stop(target: ParticipantTarget): Promise<ParticipantStopResult> {
    const outcome = await this.request({ operation: 'participant.stop', payload: this.target(target) });
    if (outcome.kind !== 'completed') return { kind: 'unknown' };
    const result = outcome.result;
    if (result.operation !== 'participant.stop') return { kind: 'unknown' };
    if (result.outcome === 'refused' && result.reason === 'unknown-run') return { kind: 'not-prepared' };
    if (result.outcome !== 'ok' || !result.terminal || result.state === 'not-owned') return { kind: 'unknown' };
    if (result.state === 'exited' && result.groupCleared !== false) return { kind: 'confirmed', event: result.terminal };
    return { kind: 'cleanup-uncertain', event: result.terminal, owned: result.state === 'cleanup-pending' };
  }
  private async status(target: ParticipantTarget): Promise<ParticipantStatusResult> {
    const outcome = await this.request({ operation: 'participant.status', payload: this.target(target) });
    if (outcome.kind !== 'completed') return { kind: 'unknown' };
    const result = outcome.result;
    if (result.operation !== 'participant.status' || result.outcome !== 'ok') return { kind: 'unknown' };
    return { kind: 'status', state: result.state, lastSequence: result.lastSequence, terminal: result.terminal,
      groupCleared: result.groupCleared, unknownReason: result.unknownReason };
  }
  private async reconcile(target: ParticipantTarget & { readonly afterSequence: number }): Promise<ParticipantReconcileResult> {
    const base = this.target(target);
    let cursor = target.afterSequence;
    let lastSequence: number | null = null;
    let lastAt: string | null = null;
    let textBytes = 0;
    let retainedBytes = 0;
    const events: ParticipantEvent[] = [];
    const partial = (): ParticipantReconcileResult => events.length ? { kind: 'events', events, more: true } : { kind: 'unknown' };
    for (let page = 0; page < MAX_REPLAY_PAGES; page++) {
      const outcome = await this.request({ operation: 'participant.events', payload: { ...base, afterSequence: cursor, maxEvents: 64 } });
      // Revocation clears text instead of handing a stale connection's private tail to its view.
      if (!this.active) return { kind: 'unknown' };
      if (outcome.kind !== 'completed') return partial();
      const result = outcome.result;
      if (result.operation !== 'participant.events' || result.outcome !== 'ok') return partial();
      if (lastSequence !== null && (result.lastSequence === null || result.lastSequence < lastSequence)) return partial();
      lastSequence = result.lastSequence;
      if (result.lost) return events.length ? partial() : { kind: 'lost', lost: result.lost, terminal: result.terminal };
      // An unknown high-water mark cannot confirm that a restored run has
      // replayed everything, even when this response contains no events.
      if (result.lastSequence === null) return partial();
      if (lastAt !== null && result.events.length && result.events[0].at < lastAt) return partial();
      for (const event of result.events) {
        const textSize = event.type === 'text' ? bytes(event.text) : 0;
        const serializedSize = bytes(JSON.stringify(event));
        if (textBytes + textSize > MAX_REPLAY_TEXT_BYTES || retainedBytes + serializedSize > MAX_REPLAY_BYTES) return partial();
        events.push(event);
        textBytes += textSize;
        retainedBytes += serializedSize;
        cursor = event.sequence;
        lastAt = event.at;
      }
      if (!result.more) return { kind: 'events', events, more: false };
    }
    return { kind: 'events', events, more: true };
  }
  private target(target: ParticipantTarget) {
    return { workspaceHandle: this.options.workspaceHandle, runId: target.runId, sessionId: target.sessionId };
  }
  private async request(request: WithoutRequestId<NativeProofRequest>): Promise<NativeRequestOutcome<NativeProofResult>> {
    if (!this.active) return { kind: 'unavailable', reason: 'revoked' };
    let outcome: NativeRequestOutcome<NativeProofResult>;
    try { outcome = await this.options.client.request({ ...request, requestId: this.options.requestId() } as NativeProofRequest); }
    catch { return { kind: 'unknown', reason: 'transport' }; }
    if (!this.active) return { kind: 'unknown', reason: 'revoked' };
    if (outcome.kind === 'completed' && outcome.result.outcome === 'refused' && knownLock.has(outcome.result.reason)) this.revoke();
    else if (outcome.kind !== 'completed' && 'reason' in outcome && outcome.reason === 'revoked') this.revoke();
    return outcome;
  }
  private readonly receive: EventListener = (event) => {
    if (!this.active) return;
    try {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      const decoded = decodeNativeParticipantPush(this.context, detail);
      if (decoded) {
        for (const listener of this.listeners) { try { listener(decoded); } catch { /* Observers do not own the lane. */ } }
        return;
      }
      if (!detail || typeof detail !== 'object' || Object.getPrototypeOf(detail) !== Object.prototype) return;
      const fields = Object.getOwnPropertyDescriptors(detail);
      const keys = ['type', 'connectionId', 'generation', 'state', 'reason'];
      if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key], 'value'))) return;
      if (fields.type.value === 'host.connection' && fields.connectionId.value === this.context.connectionId
        && fields.generation.value === this.context.documentGeneration && typeof fields.reason.value === 'string'
        && bytes(fields.reason.value) <= 65_536 && ['locked', 'revoked'].includes(fields.state.value)) this.revoke();
    } catch { /* Ignore malformed pushes without exposing or logging their contents. */ }
  };
  private revoke(notify = true): void {
    if (!this.active) return;
    this.active = false;
    this.checking = false;
    this.entry = null;
    this.local = Object.freeze([]);
    this.route = null;
    this.error = 'revoked';
    this.options.client.revoke();
    if (this.attached) {
      this.attached = false;
      try { this.options.events.removeEventListener('trueconvo-host', this.receive); } catch { /* Revocation is still final. */ }
    }
    this.listeners.clear();
    this.publish();
    this.changed.clear();
    if (notify) { try { this.options.onRevoked?.(); } catch { /* A consumer cannot undo revocation. */ } }
  }
  private publish(): void { for (const listener of this.changed) { try { listener(); } catch { /* Observers are isolated. */ } } }
}
