import { NATIVE_PARTICIPANT_OPERATIONS, isNativeParticipantOperation, type NativeParticipantOperation } from './native-participant-codec';

/**
 * Inert request lifecycle for a future native adapter, not a native wire protocol.
 * Nothing imports this into the hosted preview. A caller must supply the agreed
 * schema codec and an explicitly initialized, host-bound transport. JavaScript
 * identities are correlation data, never evidence of native authentication.
 */
export type NativeProofOperation = 'host.capabilities' | 'workspace.read' | 'workspace.commitProof'
  | 'dictation.bindDraft' | 'dictation.unbindDraft' | NativeParticipantOperation;

export interface NativeDocumentContext {
  readonly connectionId: string;
  readonly documentGeneration: number;
}

export interface PreparedNativeRequest {
  readonly requestId: string;
  readonly operation: NativeProofOperation;
  /** Exact serialized bytes are retained for explicit reconciliation only. */
  readonly wire: string;
}

export interface DecodedNativeReply<Result> extends NativeDocumentContext {
  readonly requestId: string;
  readonly operation: NativeProofOperation;
  readonly result: Result;
}

export interface NativeHostCodec<Request, Result> {
  /** Validate/serialize without registering a new request or consuming capacity. */
  prepare(context: NativeDocumentContext, request: Request): PreparedNativeRequest;
  /** Called only after a new request passes the lifecycle's dispatch gates. */
  register?(request: PreparedNativeRequest): void;
  /** Release metadata only for a completed result already returned to a caller. */
  forget?(requestId: string): void;
  /**
   * Validate the entire agreed schema, refusing unknown versions/verbs/fields.
   * Return undefined for invalid input or a nonterminal receipt. A commit result
   * is terminal only after the native authority reports its durable outcome;
   * this utility cannot establish durability or turn an ACK into a saved result.
   */
  decode(wire: string): DecodedNativeReply<Result> | undefined;
}

export interface NativeHostTransport {
  /** A throw/rejection may happen after dispatch: it never proves non-delivery. */
  send(wire: string): void | Promise<void>;
  listen(reply: (wire: string) => void, revoked: () => void): () => void;
}

export interface NativeHostClientOptions extends NativeDocumentContext {
  /** Explicit test/integration bounds; these do not silently adopt proof limits. */
  readonly maxWireBytes: number;
  readonly maxRetainedRequests: number;
  readonly timeoutMs: number;
  /** Explicit bounds for injected tests/integration; participant defaults are start 20 s, other calls 15 s. */
  readonly operationTimeoutMs?: Partial<Record<NativeProofOperation, number>>;
}

export type NativeRequestOutcome<Result> =
  | { readonly kind: 'completed'; readonly result: Result }
  | { readonly kind: 'unknown'; readonly reason: 'timeout' | 'cancelled' | 'transport' | 'revoked' }
  | { readonly kind: 'refused'; readonly reason: 'invalid-request' | 'identity-reused' | 'cancelled-before-send' | 'not-reconcilable' }
  | { readonly kind: 'unavailable'; readonly reason: 'revoked' | 'mutation-unresolved' | 'request-capacity' };

type Entry<Result> = {
  request: PreparedNativeRequest;
  mutating: boolean;
  state: 'pending' | 'unknown' | 'completed';
  outcome?: NativeRequestOutcome<Result>;
  promise?: Promise<NativeRequestOutcome<Result>>;
  settle?: (outcome: NativeRequestOutcome<Result>) => void;
};

const operations = new Set<NativeProofOperation>([
  'host.capabilities', 'workspace.read', 'workspace.commitProof', 'dictation.bindDraft', 'dictation.unbindDraft',
  ...NATIVE_PARTICIPANT_OPERATIONS,
]);
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** Clone and freeze JSON-shaped data so callers cannot mutate a cached result. */
function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item)
      || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError();
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
    seen.delete(item);
  };
  freeze(copy);
  return copy;
}

/**
 * No network, browser persistence, provider execution or automatic retry exists
 * here. Cancellation stops this wait, not native work. A dispatched mutation
 * stays unresolved until an exact terminal reply, including after timeout or
 * cancellation; only reconcile() resends its identical bytes and request ID.
 * A caller joining an already pending attempt can cancel its own wait without
 * changing that attempt, its other waiters, or the unresolved mutation barrier.
 * Recent returned terminal results are bounded; oldest ones may be evicted to
 * admit new work. Pending, unknown and not-yet-reconciled late terminal results
 * stay pinned for workspace operations. Settled participant uncertainty is
 * evictable and must be resolved with a fresh status request, never a resend.
 * Exact-byte reuse checks and cached replay apply within that
 * retention window. New work must use fresh IDs; the native durable ledger is
 * authoritative for older duplicate identities and changed-payload refusal.
 *
 * Revocation (lock/navigation/close) clears this client's retained text and
 * terminal results and permanently closes it. The integration must also clear any
 * private data it already displayed and reconcile the native authority before
 * allowing a replacement connection to write.
 */
export class NativeHostClient<Request, Result> {
  private readonly context: NativeDocumentContext;
  private readonly options: NativeHostClientOptions;
  private readonly entries = new Map<string, Entry<Result>>();
  private readonly completed = new Set<string>();
  private mutationId: string | undefined;
  private active = true;
  private detach: (() => void) | undefined;

  constructor(
    private readonly transport: NativeHostTransport,
    private readonly codec: NativeHostCodec<Request, Result>,
    options: NativeHostClientOptions,
  ) {
    if (typeof options.connectionId !== 'string' || !options.connectionId || !Number.isSafeInteger(options.documentGeneration) || options.documentGeneration < 0
      || !positiveInteger(options.maxWireBytes) || !positiveInteger(options.maxRetainedRequests)
      || !positiveInteger(options.timeoutMs) || options.timeoutMs > 2_147_483_647
      || options.operationTimeoutMs !== undefined && Object.entries(options.operationTimeoutMs).some(([key, value]) =>
        !operations.has(key as NativeProofOperation) || !positiveInteger(value) || value > 2_147_483_647)) {
      throw new TypeError('Native request lifecycle configuration is invalid.');
    }
    this.options = Object.freeze({ ...options, ...(options.operationTimeoutMs ? { operationTimeoutMs: Object.freeze({ ...options.operationTimeoutMs }) } : {}) });
    this.context = Object.freeze({ connectionId: options.connectionId, documentGeneration: options.documentGeneration });
    try {
      const detach = transport.listen((wire) => this.receive(wire), () => this.revoke());
      // A transport may report revocation synchronously while subscribing.
      if (this.active) this.detach = detach;
      else detach();
    } catch {
      this.revoke();
    }
  }

  request(request: Request, signal?: AbortSignal): Promise<NativeRequestOutcome<Result>> {
    if (!this.active) return Promise.resolve({ kind: 'unavailable', reason: 'revoked' });
    let prepared: PreparedNativeRequest;
    try {
      prepared = this.codec.prepare(this.context, snapshot(request));
      if (!prepared || typeof prepared.requestId !== 'string' || !prepared.requestId
        || !operations.has(prepared.operation) || typeof prepared.wire !== 'string'
        || !prepared.wire || byteLength(prepared.wire) > this.options.maxWireBytes) throw new TypeError();
      prepared = Object.freeze({ requestId: prepared.requestId, operation: prepared.operation, wire: prepared.wire });
    } catch {
      return Promise.resolve({ kind: 'refused', reason: 'invalid-request' });
    }
    if (!this.active) return Promise.resolve({ kind: 'unavailable', reason: 'revoked' });
    const existing = this.entries.get(prepared.requestId);
    if (existing) {
      if (existing.request.operation !== prepared.operation || existing.request.wire !== prepared.wire) {
        return Promise.resolve({ kind: 'refused', reason: 'identity-reused' });
      }
      // Repeating request() cannot silently retry a possibly completed action.
      return this.join(existing, signal);
    }
    if (signal?.aborted) return Promise.resolve({ kind: 'refused', reason: 'cancelled-before-send' });
    const mutating = prepared.operation === 'workspace.commitProof' || prepared.operation === 'dictation.bindDraft' || prepared.operation === 'dictation.unbindDraft';
    if (mutating && this.mutationId !== undefined) {
      return Promise.resolve({ kind: 'unavailable', reason: 'mutation-unresolved' });
    }
    if (this.entries.size >= this.options.maxRetainedRequests && !this.evictCompleted()) {
      return Promise.resolve({ kind: 'unavailable', reason: this.active ? 'request-capacity' : 'revoked' });
    }
    try { this.codec.register?.(prepared); }
    catch { return Promise.resolve({ kind: 'refused', reason: 'invalid-request' }); }
    // An injected registration hook may synchronously revoke the transport.
    if (!this.active) return Promise.resolve({ kind: 'unavailable', reason: 'revoked' });
    if (signal?.aborted) return Promise.resolve({ kind: 'refused', reason: 'cancelled-before-send' });
    const entry: Entry<Result> = { request: prepared, mutating, state: 'pending' };
    this.entries.set(prepared.requestId, entry);
    if (mutating) this.mutationId = prepared.requestId;
    return this.dispatch(entry, signal);
  }

  /** Explicitly reconcile a previously dispatched request, with identical bytes. */
  reconcile(requestId: string, signal?: AbortSignal): Promise<NativeRequestOutcome<Result>> {
    if (!this.active) return Promise.resolve({ kind: 'unavailable', reason: 'revoked' });
    const entry = this.entries.get(requestId);
    if (!entry) return Promise.resolve({ kind: 'refused', reason: 'not-reconcilable' });
    if (entry.state !== 'unknown') return this.join(entry, signal);
    // An uncertain participant call is resolved with a fresh status request, never a resend.
    if (isNativeParticipantOperation(entry.request.operation)) return Promise.resolve({ kind: 'refused', reason: 'not-reconcilable' });
    if (signal?.aborted) return Promise.resolve({ kind: 'refused', reason: 'cancelled-before-send' });
    return this.dispatch(entry, signal);
  }

  revoke(): void {
    if (!this.active) return;
    this.active = false;
    for (const entry of this.entries.values()) {
      entry.settle?.({ kind: 'unknown', reason: 'revoked' });
      // A still-pending transport Promise can retain its attempt's closure.
      // Drop our payload/result references even while that Promise is alive.
      entry.request = Object.freeze({ ...entry.request, wire: '' });
      entry.outcome = undefined;
    }
    this.entries.clear();
    this.completed.clear();
    this.mutationId = undefined;
    const detach = this.detach;
    this.detach = undefined;
    try { detach?.(); } catch { /* Revocation remains final even if transport cleanup fails. */ }
  }

  private join(entry: Entry<Result>, signal?: AbortSignal): Promise<NativeRequestOutcome<Result>> {
    const pending = entry.promise;
    if (!pending) {
      // A late terminal result remains pinned until it is explicitly returned
      // to a caller reconciling the original identity.
      if (entry.state === 'completed') {
        this.completed.add(entry.request.requestId);
        if (entry.mutating && this.mutationId === entry.request.requestId) this.mutationId = undefined;
      }
      return Promise.resolve(entry.outcome!);
    }
    if (!signal) return pending;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: NativeRequestOutcome<Result>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        resolve(Object.freeze(outcome));
      };
      const cancel = () => settle({ kind: 'unknown', reason: 'cancelled' });
      // This identity has already been dispatched, even if this waiter cancels
      // before joining it. Do not claim that native work was never sent.
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      // Client-owned attempt promises always resolve to an outcome. Settling a
      // joined wait never calls entry.settle or changes its retained outcome.
      void pending.then(settle);
    });
  }

  private evictCompleted(): boolean {
    const id = this.completed.values().next().value;
    if (id === undefined) return false;
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'completed' && !(entry.state === 'unknown' && isNativeParticipantOperation(entry.request.operation))) return false;
    try { this.codec.forget?.(id); } catch { return false; }
    if (!this.active) return false;
    this.completed.delete(id);
    this.entries.delete(id);
    // A late transport Promise may still retain this entry through its settler.
    entry.request = Object.freeze({ ...entry.request, wire: '' });
    entry.outcome = undefined;
    return true;
  }

  private dispatch(entry: Entry<Result>, signal?: AbortSignal): Promise<NativeRequestOutcome<Result>> {
    entry.state = 'pending';
    entry.outcome = undefined;
    let resolve!: (outcome: NativeRequestOutcome<Result>) => void;
    const promise = new Promise<NativeRequestOutcome<Result>>((done) => { resolve = done; });
    entry.promise = promise;
    let settled = false;
    const cancel = () => settle({ kind: 'unknown', reason: 'cancelled' });
    const operation = entry.request.operation;
    const timeoutMs = this.options.operationTimeoutMs?.[operation] ?? (isNativeParticipantOperation(operation)
      ? operation === 'participant.start' ? 20_000 : 15_000 : this.options.timeoutMs);
    const timeout = setTimeout(() => settle({ kind: 'unknown', reason: 'timeout' }), timeoutMs);
    const settle = (outcome: NativeRequestOutcome<Result>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      entry.state = outcome.kind === 'completed' ? 'completed' : 'unknown';
      // Native retains process truth; settled participant uncertainty must not exhaust this polling lane.
      if (isNativeParticipantOperation(entry.request.operation)) this.completed.add(entry.request.requestId);
      entry.outcome = Object.freeze(outcome);
      entry.promise = undefined;
      entry.settle = undefined;
      resolve(entry.outcome);
    };
    entry.settle = settle;
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const sent = this.transport.send(entry.request.wire);
      // This attempt's settler cannot cancel a later reconciliation attempt.
      Promise.resolve(sent).catch(() => settle({ kind: 'unknown', reason: 'transport' }));
    } catch {
      settle({ kind: 'unknown', reason: 'transport' });
    }
    return promise;
  }

  private receive(wire: string): void {
    if (!this.active || typeof wire !== 'string' || byteLength(wire) > this.options.maxWireBytes) return;
    let reply: DecodedNativeReply<Result> | undefined;
    try { reply = this.codec.decode(wire); } catch { return; }
    if (!reply || reply.connectionId !== this.context.connectionId
      || reply.documentGeneration !== this.context.documentGeneration) return;
    const entry = this.entries.get(reply.requestId);
    if (!entry || entry.state === 'completed' || reply.operation !== entry.request.operation) return;
    let outcome: NativeRequestOutcome<Result>;
    try { outcome = Object.freeze({ kind: 'completed', result: snapshot(reply.result) }); } catch { return; }
    if (entry.settle) {
      if (entry.mutating && this.mutationId === reply.requestId) this.mutationId = undefined;
      this.completed.add(reply.requestId);
      entry.settle(outcome);
    }
    else {
      // A late terminal reply can resolve an unknown outcome without resending.
      entry.state = 'completed';
      entry.outcome = outcome;
    }
  }
}
