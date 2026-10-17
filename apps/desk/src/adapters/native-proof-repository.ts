import { LOCAL_PARTICIPANT_ID } from '../domain/conversation-runs';
import type { DeskState } from '../domain/types';
import { validateState } from '../domain/validation';
import type { NativeHostClient, NativeRequestOutcome } from './native-host-client';
import type { NativeProofRequest, NativeProofResult } from './native-host-codec';
import type { ParticipantRunClaim } from './native-participant-codec';
import type { WorkspaceLoadResult, WorkspaceRepository, WorkspaceSaveOptions, WorkspaceSaveResult } from './workspace-repository';

type Client = NativeHostClient<NativeProofRequest, NativeProofResult>;
export interface NativeProofRepositoryOptions { readonly participants?: boolean }
type Attempt = {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly participantRun?: ParticipantRunClaim;
  readonly dictationDeliveryId?: string;
  state?: DeskState;
  promise?: Promise<WorkspaceSaveResult>;
  resolve?: (result: WorkspaceSaveResult) => void;
};
const unavailable = (): WorkspaceSaveResult => ({ kind: 'unavailable', error: 'The native workspace connection is unavailable. No replacement was created.' });
const loadUnavailable = (): WorkspaceLoadResult => ({ kind: 'unavailable', error: 'The native workspace could not be opened. Existing work was not replaced and browser storage was not used.' });
const uuid4 = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

/**
 * Injected invented-data native authority. This does not discover a host, open
 * browser storage, initialize an empty workspace, reconnect or retry on its own.
 * The host provisions the first proof record; a missing/corrupt store refuses.
 *
 * A timeout keeps one original snapshot and request identity until an explicit
 * same-connection reconcilePending(). New saves cannot replace that attempt.
 * The runtime owns visible state and must revoke this repository, its client
 * and codec together on native lock/navigation/close. Repository revocation
 * clears its own payload references and settles outstanding callers without
 * exposing those payloads; the client separately owns its serialized requests.
 */
export class NativeProofRepository implements WorkspaceRepository {
  private active = true;
  private pending?: Attempt;
  private readonly listeners = new Set<() => void>();
  private readonly reads = new Set<() => void>();
  private readonly participants: boolean;
  private committed?: { readonly revision: number; readonly runIds: ReadonlySet<string> };

  constructor(
    private readonly client: Client,
    private readonly workspaceHandle: string,
    private readonly requestId: () => string,
    private readonly onRevoked?: () => void,
    options?: NativeProofRepositoryOptions,
  ) {
    if (typeof workspaceHandle !== 'string' || !workspaceHandle
      || new TextEncoder().encode(workspaceHandle).byteLength > 65_536 || typeof requestId !== 'function'
      || onRevoked !== undefined && typeof onRevoked !== 'function'
      || options !== undefined && (!options || typeof options !== 'object'
        || options.participants !== undefined && typeof options.participants !== 'boolean')) {
      throw new TypeError('The native proof repository configuration is invalid.');
    }
    this.participants = options?.participants === true;
  }

  subscribe(changed: () => void): () => void {
    if (!this.active) return () => {};
    this.listeners.add(changed);
    return () => { this.listeners.delete(changed); };
  }

  loadLatest(): Promise<WorkspaceLoadResult> {
    if (!this.active) return Promise.resolve(loadUnavailable());
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WorkspaceLoadResult) => {
        if (settled) return;
        settled = true;
        this.reads.delete(revoked);
        resolve(result);
      };
      const revoked = () => finish(loadUnavailable());
      this.reads.add(revoked);
      try {
        const id = this.nextId();
        void this.client.request({ requestId: id, operation: 'workspace.read', payload: { workspaceHandle: this.workspaceHandle } }).then((outcome) => {
          try {
            if (settled || !this.active) { finish(loadUnavailable()); return; }
            if (outcome.kind === 'completed' && outcome.result.operation === 'workspace.read' && outcome.result.outcome === 'ok') {
              const state = structuredClone(outcome.result.record);
              if (validateState(state).valid && state.revision === outcome.result.revision) {
                this.rememberCommitted(state);
                finish({ kind: 'ready', state }); return;
              }
            }
            if (this.closedOutcome(outcome)) this.revoke();
            finish(loadUnavailable());
          } catch { finish(loadUnavailable()); }
        }, () => finish(loadUnavailable()));
      } catch { finish(loadUnavailable()); }
    });
  }

  save(state: DeskState, expectedRevision: number | null, options?: WorkspaceSaveOptions): Promise<WorkspaceSaveResult> {
    if (!this.active) return Promise.resolve(unavailable());
    if (this.pending) return this.pending.promise ?? Promise.resolve(this.unknown(this.pending));
    let captured: DeskState;
    try { captured = structuredClone(state); }
    catch { return Promise.resolve(unavailable()); }
    const failed = (): WorkspaceSaveResult => ({ kind: 'failed', error: 'The native save was refused before dispatch. Your attempted work remains separate from the saved workspace.', attemptedState: captured });
    if (!validateState(captured).valid || !Number.isSafeInteger(expectedRevision) || expectedRevision === null
      || expectedRevision < 0 || captured.revision <= expectedRevision) return Promise.resolve(failed());
    const dictationDeliveryId = options?.dictationDeliveryId;
    if (dictationDeliveryId !== undefined && !uuid4(dictationDeliveryId)) return Promise.resolve(failed());
    let participantRun: ParticipantRunClaim | undefined;
    if (this.participants) {
      // Only a validated native read or durable success establishes what the
      // store already has. A stale snapshot cannot safely identify new runs.
      if (!this.committed || this.committed.revision !== expectedRevision) return Promise.resolve(failed());
      const introduced = (captured.conversationRuns ?? []).filter((run) => !this.committed!.runIds.has(run.runId));
      if (introduced.length > 1) return Promise.resolve(failed());
      const run = introduced[0];
      if (run) {
        // Validation also accepts later recovery annotations. Native preparation
        // permits only the original twelve fields, without reason or closure,
        // plus `contextRunIds` for a local model's run (contract section 20.3;
        // step 3 PR 4b: without it a local run was never sent to the Mac).
        const local = run.participant.id === LOCAL_PARTICIPANT_ID;
        if (run.phase !== 'prepared' || Object.keys(run).length !== (local ? 13 : 12)
          || local !== Object.hasOwn(run, 'contextRunIds')) return Promise.resolve(failed());
        participantRun = { runId: run.runId, sessionId: run.sessionId, userMessageId: run.userMessageId,
          assistantMessageId: run.assistantMessageId, participantId: run.participant.id, createdAt: run.createdAt };
      }
    }
    let id: string;
    try { id = this.nextId(); }
    catch { return Promise.resolve(failed()); }
    // A delivery commit only places dictated text; it never also starts a run.
    if (participantRun && dictationDeliveryId) return Promise.resolve(failed());
    const attempt: Attempt = { requestId: id, expectedRevision, state: captured, ...(participantRun ? { participantRun } : {}),
      ...(dictationDeliveryId ? { dictationDeliveryId } : {}) };
    this.pending = attempt;
    return this.dispatch(attempt, false);
  }

  /** Exact original identity and bytes, same client/document only; never new-ID replay. */
  reconcilePending(): Promise<WorkspaceSaveResult> {
    if (!this.active || !this.pending) return Promise.resolve(unavailable());
    return this.pending.promise ?? this.dispatch(this.pending, true);
  }

  revoke(): void {
    if (!this.active) return;
    this.active = false;
    this.committed = undefined;
    const attempt = this.pending;
    this.pending = undefined;
    if (attempt) {
      attempt.state = undefined;
      const resolve = attempt.resolve;
      attempt.resolve = undefined;
      attempt.promise = undefined;
      resolve?.(unavailable());
    }
    for (const revoked of [...this.reads]) revoked();
    this.reads.clear();
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const changed of listeners) {
      try { changed(); } catch { /* One listener cannot prevent other revocation notifications. */ }
    }
    // A terminal lock reply is sufficient authority to clear the entire visit;
    // do not wait for a separately delivered host.connection event.
    try { this.onRevoked?.(); } catch { /* Local revocation has already settled and cleared its work. */ }
  }

  private nextId(): string {
    const id = this.requestId();
    if (typeof id !== 'string' || !uuid4(id)) throw new TypeError('The native request identity is invalid.');
    return id;
  }

  private rememberCommitted(state: DeskState): void {
    if (!this.participants || this.committed && state.revision <= this.committed.revision) return;
    // Reads can finish out of order, including after a newer save. Keep only
    // identities, not another retained copy of the conversation payload.
    this.committed = { revision: state.revision, runIds: new Set((state.conversationRuns ?? []).map((run) => run.runId)) };
  }

  private unknown(attempt: Attempt): WorkspaceSaveResult {
    if (!this.active || !attempt.state) return unavailable();
    return { kind: 'unknown', requestId: attempt.requestId,
      error: 'The native save outcome is unknown. Check this original request before saving again; no new save was sent.',
      attemptedState: structuredClone(attempt.state) };
  }

  private dispatch(attempt: Attempt, reconcile: boolean): Promise<WorkspaceSaveResult> {
    let resolve!: (result: WorkspaceSaveResult) => void;
    const promise = new Promise<WorkspaceSaveResult>((done) => { resolve = done; });
    attempt.promise = promise;
    attempt.resolve = resolve;
    const settle = (result: WorkspaceSaveResult) => {
      if (attempt.resolve !== resolve) return;
      attempt.resolve = undefined;
      attempt.promise = undefined;
      resolve(result);
    };
    try {
      const result = reconcile ? this.client.reconcile(attempt.requestId) : this.client.request({
        requestId: attempt.requestId, operation: 'workspace.commitProof', payload: {
          workspaceHandle: this.workspaceHandle, expectedRevision: attempt.expectedRevision, record: attempt.state!,
          ...(attempt.participantRun ? { participantRun: attempt.participantRun } : {}),
          ...(attempt.dictationDeliveryId ? { dictationDeliveryId: attempt.dictationDeliveryId } : {}),
        },
      });
      void result.then((outcome) => {
        try { settle(this.complete(attempt, outcome, reconcile)); }
        catch { settle(this.unknown(attempt)); }
      }, () => settle(this.unknown(attempt)));
    } catch {
      // An injected boundary could throw after dispatch; only an explicit known
      // pre-dispatch result may discard the original transaction identity.
      settle(this.unknown(attempt));
    }
    return promise;
  }

  private closedOutcome(outcome: NativeRequestOutcome<NativeProofResult>): boolean {
    return (outcome.kind === 'unavailable' || outcome.kind === 'unknown') && outcome.reason === 'revoked'
      || outcome.kind === 'completed' && outcome.result.outcome === 'refused'
      && (outcome.result.reason === 'store-locked' || outcome.result.reason === 'locked');
  }

  private complete(attempt: Attempt, outcome: NativeRequestOutcome<NativeProofResult>, reconciling: boolean): WorkspaceSaveResult {
    if (!this.active || this.pending !== attempt || !attempt.state) return unavailable();
    if (this.closedOutcome(outcome)) {
      this.revoke();
      return unavailable();
    }
    if (outcome.kind === 'unknown' || reconciling && outcome.kind !== 'completed') return this.unknown(attempt);
    if (outcome.kind === 'completed' && outcome.result.operation !== 'workspace.commitProof') return this.unknown(attempt);
    const attemptedState = structuredClone(attempt.state);
    let result: WorkspaceSaveResult;
    if (outcome.kind === 'completed') {
      const reply = outcome.result;
      if (reply.outcome === 'ok' && reply.operation === 'workspace.commitProof') {
        if (reply.revision !== attemptedState.revision) return this.unknown(attempt);
        this.rememberCommitted(attemptedState);
        result = { kind: 'saved', state: attemptedState };
      } else if (reply.outcome === 'conflict') {
        result = { kind: 'conflict', error: 'The native workspace changed before this save. Your attempted work remains separate; no replacement was written.', attemptedState };
      } else {
        result = { kind: 'failed', error: 'The native host refused this save. Your attempted work remains separate from the saved workspace.', attemptedState };
      }
    } else {
      result = { kind: 'failed', error: 'The native save was not dispatched. Your attempted work remains separate from the saved workspace.', attemptedState };
    }
    attempt.state = undefined;
    this.pending = undefined;
    return result;
  }
}
