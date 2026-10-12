import type { ConversationRun, ParticipantEvent, ParticipantIdentity, ParticipantTerminalEvent, LostRange } from '../domain/conversation-run-types';
import { acknowledgeUnreachableCleanup, appendParticipantEvent, closeConversationRun, freezeConversationRun, isConversationRunClosed,
  validateConversationRun, validateParticipantEvent } from '../domain/conversation-runs';

export interface ParticipantStartInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly participant: Readonly<ParticipantIdentity>;
  readonly inputChunks: readonly string[];
}
export interface ParticipantTarget { readonly runId: string; readonly sessionId: string }
export type { LostRange } from '../domain/conversation-run-types';
export type ParticipantStartResult = { kind: 'accepted' | 'unknown' }
  | { kind: 'not-started'; reason?: string; retryable?: boolean };
export type ParticipantStopResult = { kind: 'confirmed'; event: ParticipantEvent }
  | { kind: 'cleanup-uncertain'; event: ParticipantTerminalEvent; owned: boolean }
  | { kind: 'not-prepared' | 'unknown' };
/** Optional cleanup evidence; adding this capability does not activate a native participant. */
export type ParticipantStatusResult = { kind: 'unknown' } | { kind: 'status';
  state: 'not-dispatched' | 'starting' | 'running' | 'stopping' | 'cleanup-pending' | 'exited' | 'unknown';
  lastSequence: number | null; terminal: ParticipantTerminalEvent | null; groupCleared: boolean | null;
  unknownReason: 'store-unreadable' | 'start-uncertain' | 'exit-unrecorded' | null };
export type ParticipantCleanupState = 'none' | 'unknown' | 'owned' | 'unowned' | 'cleared';
export type ParticipantReconcileResult = { kind: 'events'; events: ParticipantEvent[]; more?: boolean }
  | { kind: 'lost'; lost: LostRange; terminal: ParticipantTerminalEvent | null } | { kind: 'unknown' };

/** An explicitly injected, owned participant. This module selects no provider or transport. */
export interface ParticipantPort {
  readonly identity: Readonly<ParticipantIdentity>;
  subscribe(listener: (event: unknown) => void): () => void;
  /** The owned native adapter may supply its own fresh check, rather than the picker's display cache. */
  start(input: ParticipantStartInput, mayDispatch?: (evidence?: { availabilityConfirmed: true }) => boolean): Promise<ParticipantStartResult>;
  stop(target: ParticipantTarget): Promise<ParticipantStopResult>;
  reconcile(target: ParticipantTarget & { readonly afterSequence: number }): Promise<ParticipantReconcileResult>;
  status?(target: ParticipantTarget): Promise<ParticipantStatusResult>;
  /** Availability never disables recovery reads or Stop. */
  canStart?(): boolean;
}
export type RunCheckpointResult = { kind: 'saved'; record: ConversationRun } | { kind: 'not-saved' | 'blocked' | 'unknown' };
export type RunCheckpoint = (record: Readonly<ConversationRun>) => Promise<RunCheckpointResult>;
export type CheckpointResolution = { kind: 'saved' | 'not-saved'; record: ConversationRun };
export type ConversationRunStatus = 'idle' | 'preparing' | 'starting' | 'running' | 'stopping' | 'unknown' | 'terminal' | 'unavailable' | 'disposed';
export type RunRuntimeError = 'checkpoint-unknown' | 'checkpoint-failed' | 'checkpoint-blocked' | 'start-unknown' | 'start-refused'
  | 'stop-unknown' | 'reconcile-unknown' | 'event-gap' | 'event-refused' | 'subscription-failed' | 'workspace-limit' | 'recovery-size-limit';
export interface ConversationRunSnapshot {
  readonly run: Readonly<ConversationRun>;
  readonly available: boolean;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canCheckStatus: boolean;
  readonly canCloseAsUnknown: boolean;
  readonly canAcknowledgeUnreachableCleanup: boolean;
  readonly cleanupState: ParticipantCleanupState;
  readonly cleanupPending: boolean;
  readonly savedRecord: Readonly<ConversationRun> | null;
  readonly persistedSequence: number | null;
  readonly persistedPrefix: string;
  readonly unsavedTail: string;
  readonly outputText: string;
  readonly saving: boolean;
  readonly checkpointState: 'idle' | 'saving' | 'saved' | 'unknown' | 'failed' | 'blocked';
  readonly stopState: 'idle' | 'pending' | 'unknown' | 'confirmed';
  readonly status: ConversationRunStatus;
  readonly error: RunRuntimeError | null;
  readonly startRefusal: Readonly<{ reason: string; retryable: boolean }> | null;
  readonly eventBufferOverflow: boolean;
  readonly pendingEvents: readonly ParticipantEvent[];
}
export interface ParticipantRuntimeScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  yield(): Promise<void>;
}
export interface ConversationRunControllerOptions {
  run: ConversationRun;
  port: ParticipantPort;
  checkpoint: RunCheckpoint;
  /** Restoring an ID authorizes reads, never dispatch. */
  mode: 'new' | 'restored';
  acceptRun?: (next: Readonly<ConversationRun>) => boolean;
  /** Global workspace/save barriers are checked again after every await. */
  canDispatch?: () => boolean;
  scheduler?: ParticipantRuntimeScheduler;
}
export const RUN_CHECKPOINT_INTERVAL_MS = 5000;
export const PARTICIPANT_STOP_TIMEOUT_MS = 15_000;
export const PARTICIPANT_QUIET_POLL_MS = 15_000;
export const MAX_PENDING_PARTICIPANT_EVENTS = 128;
export const MAX_PENDING_PARTICIPANT_BYTES = 256 * 1024;
const RECONCILE_BATCH_SIZE = 64;
const schedulerDefault: ParticipantRuntimeScheduler = {
  now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
};
const sameParticipant = (a: Readonly<ParticipantIdentity>, b: Readonly<ParticipantIdentity>) =>
  a.id === b.id && a.label === b.label && a.model === b.model && a.executionHost === b.executionHost;
const sameChunks = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((chunk, i) => chunk === b[i]);
const eventKey = (event: ParticipantEvent) => JSON.stringify([event.runId, event.sessionId, event.sequence,
  event.at, event.type, event.type === 'text' ? event.text : null, 'reason' in event ? event.reason : null]);
const sameRun = (a: ConversationRun, b: unknown): b is ConversationRun => a === b || (validateConversationRun(b)
  && a.version === b.version && a.runId === b.runId && a.sessionId === b.sessionId
  && a.userMessageId === b.userMessageId && a.assistantMessageId === b.assistantMessageId
  && a.createdAt === b.createdAt && sameParticipant(a.participant, b.participant) && sameChunks(a.inputChunks, b.inputChunks)
  && a.phase === b.phase && a.lastSequence === b.lastSequence && a.updatedAt === b.updatedAt
  && a.reason === b.reason && sameChunks(a.outputChunks, b.outputChunks)
  && a.cleanupAcknowledgment?.kind === b.cleanupAcknowledgment?.kind && a.cleanupAcknowledgment?.at === b.cleanupAcknowledgment?.at
  && ((!a.closure && !b.closure) || (!!a.closure && !!b.closure && a.closure.kind === b.closure.kind
    && a.closure.reason === b.closure.reason && a.closure.at === b.closure.at
    && (a.closure.kind !== 'interrupted' || a.closure.reason !== 'replay-lost'
      || b.closure.kind === 'interrupted' && b.closure.reason === 'replay-lost'
        && a.closure.lost.fromSequence === b.closure.lost.fromSequence
        && a.closure.lost.throughSequence === b.closure.lost.throughSequence && a.closure.lost.reason === b.closure.lost.reason)
    && (a.closure.kind !== 'interrupted' || (b.closure.kind === 'interrupted'
      && eventKey(a.closure.terminalEvent) === eventKey(b.closure.terminalEvent))))));
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const isTerminalEvent = (event: ParticipantEvent): event is ParticipantTerminalEvent =>
  event.type === 'completed' || event.type === 'stopped' || event.type === 'failed';

/** Literal evidence and its durable prefix. Importing this module activates no transport or storage. */
export class ConversationRunController {
  private run: ConversationRun;
  private savedRecord: ConversationRun | null;
  private outputText: string;
  private persistedPrefix: string;
  private readonly mode: 'new' | 'restored';
  private readonly checkpoint: RunCheckpoint;
  private readonly acceptRun: (next: Readonly<ConversationRun>) => boolean;
  private readonly canDispatch: () => boolean;
  private readonly scheduler: ParticipantRuntimeScheduler;
  private readonly startPort: ParticipantPort['start'];
  private readonly stopPort: ParticipantPort['stop'];
  private readonly reconcilePort: ParticipantPort['reconcile'];
  private readonly statusPort: ParticipantPort['status'];
  private readonly startAvailable: (() => boolean);
  private freshNotDispatched = false;
  private startRequiresStatus = false;
  private startRefusal: { reason: string; retryable: boolean } | null = null;
  private replayLost = false;
  private pollTimer: unknown = null;
  private evidenceClock = 0;
  private cleanupState: ParticipantCleanupState = 'none';
  private cleanupStatusInFlight = false;
  private cleanupStatusCancel: (() => void) | null = null;
  private cleanupEvidenceAttempt = 0;
  private stopAttempt = 0;
  private readonly unsettledStops = new Set<number>();
  private readonly stopTimers = new Map<number, unknown>();
  private readonly stopWaiters = new Map<number, () => void>();
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(snapshot: ConversationRunSnapshot) => void>();
  private readonly pending = new Map<number, ParticipantEvent>();
  private pendingBytes = 0;
  private readonly recentEvents = new Map<number, string>();
  private recentBytes = 0;
  private refusedThrough = 0;
  private interruptionReason: 'event-refused' | 'workspace-limit' | null = null;
  private contradictory = false;
  private attemptedStart = false;
  private notStarted = false;
  private status: ConversationRunStatus;
  private stopState: ConversationRunSnapshot['stopState'] = 'idle';
  private transportError: RunRuntimeError | null = null;
  private disposed = false;
  private startPreparing = false;
  private startOutstanding = false;
  private startPortOutstanding = false;
  private startEvidenceEpoch = 0;
  private restoredReplayPending = false;
  private dispatched = false;
  private stopRequested = false;
  private automaticStopRequested = false;
  private reconcileInFlight = false;
  private saveInFlight: Promise<void> | null = null;
  private scheduled = false;
  private timer: unknown = null;
  private lastCheckpointAt = -Infinity;
  private immediateCheckpoint = false;
  private unknownCheckpoint: ConversationRun | null = null;
  private failedCheckpoint: ConversationRun | null = null;
  private blockedCheckpoint: ConversationRun | null = null;

  constructor({ run, port, checkpoint, mode, acceptRun = () => true, canDispatch = () => true, scheduler = schedulerDefault }: ConversationRunControllerOptions) {
    const captured = freezeConversationRun(run);
    if (captured.kind !== 'ok' || (mode !== 'new' && mode !== 'restored')
      || (mode === 'new' && (run.phase !== 'prepared' || isConversationRunClosed(run)))
      || !sameParticipant(run.participant, port.identity)) throw new Error('Invalid participant run configuration');
    this.run = captured.run;
    this.savedRecord = mode === 'restored' ? this.run : null;
    this.outputText = this.run.outputChunks.join('');
    this.persistedPrefix = this.savedRecord ? this.outputText : '';
    this.mode = mode;
    this.checkpoint = checkpoint;
    this.acceptRun = acceptRun;
    this.canDispatch = canDispatch;
    this.scheduler = scheduler;
    this.startPort = port.start.bind(port);
    this.stopPort = port.stop.bind(port);
    this.reconcilePort = port.reconcile.bind(port);
    this.statusPort = port.status?.bind(port);
    this.startAvailable = port.canStart?.bind(port) ?? (() => true);
    this.startRequiresStatus = mode === 'restored';
    this.restoredReplayPending = mode === 'restored' && !isConversationRunClosed(run);
    const terminal = this.recordedTerminal();
    if (this.terminalIncomplete(terminal)) this.cleanupState = 'unknown';
    this.status = isConversationRunClosed(run) ? run.closure?.kind === 'unknown' ? 'unknown' : 'terminal'
      : mode === 'restored' ? 'unknown' : 'idle';
    if (terminal?.type === 'stopped') this.stopState = this.cleanupUnresolved() ? 'unknown' : 'confirmed';
    if (!isConversationRunClosed(run) || this.cleanupState === 'unknown' || (terminal && this.statusPort)) {
      try {
        const unsubscribe = port.subscribe((event) => this.receive(event));
        if (typeof unsubscribe !== 'function') throw new Error('Subscription unavailable');
        this.unsubscribe = unsubscribe;
        // subscribe may synchronously replay events. A refusal is retained,
        // but ownership must be established before making its automatic Stop.
        this.requestAutomaticStop();
        if (terminal) void this.readCleanupStatus();
        else if (mode === 'restored' && this.statusPort) queueMicrotask(() => { void this.reconcile(); });
        this.schedulePoll();
      } catch {
        this.status = 'unavailable';
        this.transportError = 'subscription-failed';
        this.clearTimer();
      }
    }
  }

  get currentRun(): Readonly<ConversationRun> { return this.run; }
  /** Local evidence only: safe to inspect across controllers without evaluating Start policy. */
  get startBarrier(): boolean {
    // A terminal buffered behind a gap is unsaved evidence even when cleanup
    // has cleared. Restore must finish replay before another run can replace
    // native's retained tail. A permitted saved closure releases that tail.
    return this.dirty() || this.saveInFlight !== null || this.hasCheckpointBarrier() || this.cleanupPending()
      || (!isConversationRunClosed(this.run) && (this.pending.size > 0 || this.restoredReplayPending));
  }
  get snapshot(): ConversationRunSnapshot {
    const error = this.unknownCheckpoint ? 'checkpoint-unknown' : this.failedCheckpoint ? 'checkpoint-failed'
      : this.blockedCheckpoint ? 'checkpoint-blocked' : this.transportError;
    // Keep intrinsic readiness visible; the UI disables Start for global
    // barriers, and start() enforces them again at every dispatch boundary.
    const canStart = this.canPrepareStart(false) && !this.startOutstanding && !this.startPreparing && !this.hasCheckpointBarrier() && !this.saveInFlight && !this.dirty();
    return Object.freeze({ run: this.run, available: this.unsubscribe !== null && !this.disposed, canStart,
      canStop: this.canStop(), canCloseAsUnknown: this.canCloseUnknown(),
      canAcknowledgeUnreachableCleanup: this.canAcknowledgeUnreachableCleanup(),
      cleanupState: this.cleanupState, cleanupPending: this.cleanupPending(),
      canCheckStatus: !this.disposed && this.unsubscribe !== null && (this.cleanupUnresolved() && !!this.statusPort
        || (!isConversationRunClosed(this.run) && (!!this.statusPort || this.status === 'unknown' && this.mayHaveDispatched()))),
      savedRecord: this.savedRecord, persistedSequence: this.savedRecord?.lastSequence ?? null,
      persistedPrefix: this.persistedPrefix, unsavedTail: this.outputText.slice(this.persistedPrefix.length), outputText: this.outputText,
      saving: this.saveInFlight !== null,
      checkpointState: this.unknownCheckpoint ? 'unknown' : this.failedCheckpoint ? 'failed' : this.blockedCheckpoint ? 'blocked'
        : this.saveInFlight ? 'saving' : !this.dirty() ? 'saved' : 'idle',
      status: this.status, stopState: this.stopState, error, startRefusal: this.startRefusal ? Object.freeze({ ...this.startRefusal }) : null, eventBufferOverflow: this.refusedThrough > this.run.lastSequence,
      pendingEvents: Object.freeze([...this.pending.values()].sort((a, b) => a.sequence - b.sequence)) });
  }
  subscribe(listener: (snapshot: ConversationRunSnapshot) => void): () => void {
    if (!this.disposed) this.listeners.add(listener);
    try { listener(this.snapshot); } catch { /* Observers cannot interrupt transport or persistence. */ }
    return () => { this.listeners.delete(listener); };
  }
  async start(): Promise<void> {
    if (this.startOutstanding || !this.canPrepareStart() || this.startPreparing || this.unknownCheckpoint) return;
    this.startOutstanding = true;
    let dispatchPending = false;
    try {
      this.startPreparing = true;
      this.status = 'preparing';
      this.publish();
      await this.flush();
      // A prior read enables the control, but only a fresh read in this explicit
      // action may authorize a restored/uncertain run's dispatch.
      if (this.startRequiresStatus) {
        this.freshNotDispatched = false;
        await this.readCleanupStatus();
      }
      this.startPreparing = false;
      // A known no-start response permits an explicit retry, but new evidence,
      // Stop, disposal or closure during this await revokes that permission.
      if (!this.canPrepareStart()) return;
      if (this.dirty() || this.hasCheckpointBarrier()) { this.status = 'unknown'; this.publish(); return; }
      dispatchPending = true;
      this.status = 'starting';
      this.transportError = null;
      const input: ParticipantStartInput = Object.freeze({ ...this.target(), userMessageId: this.run.userMessageId,
        assistantMessageId: this.run.assistantMessageId, participant: this.run.participant, inputChunks: this.run.inputChunks });
      this.publish();
      if (!this.canPrepareStart() || this.dirty() || this.hasCheckpointBarrier()) return;
      this.cleanupEvidenceAttempt = ++this.evidenceClock;
      this.dispatched = true;
      this.freshNotDispatched = false;
      this.startRefusal = null;
      this.attemptedStart = true;
      this.notStarted = false;
      this.startPortOutstanding = true;
      this.startEvidenceEpoch++;
      dispatchPending = false;
      try {
        const result = await this.startPort(input, (evidence) => this.dispatchStillAllowed(evidence?.availabilityConfirmed === true));
        if (this.disposed || isConversationRunClosed(this.run)) return;
        if (result.kind === 'not-started') {
          this.notStarted = true;
          this.startRefusal = { reason: result.reason ?? 'start-refused', retryable: result.retryable !== false };
          if (result.reason === 'run-not-prepared') {
            this.stopRequested = true; this.stopState = 'confirmed';
            this.status = 'terminal'; this.transportError = 'start-refused';
            void this.reconcile();
          }
          if (this.run.lastSequence || this.pending.size) this.latchContradiction();
          else if (!this.stopRequested) { this.dispatched = false; this.status = 'idle'; this.transportError = 'start-refused'; }
        } else if (result.kind !== 'accepted' && !this.stopRequested && !this.run.lastSequence) {
          this.startRequiresStatus = true; this.freshNotDispatched = false;
          this.status = 'unknown'; this.transportError = 'start-unknown';
        }
      } catch {
        if (!this.disposed && !isConversationRunClosed(this.run) && !this.stopRequested && !this.run.lastSequence) {
          this.startRequiresStatus = true; this.freshNotDispatched = false;
          this.status = 'unknown'; this.transportError = 'start-unknown';
        }
      } finally {
        this.startPortOutstanding = false;
        this.startEvidenceEpoch++;
      }
    } finally {
      this.startOutstanding = false;
      this.startPreparing = false;
      // Availability or another dispatch barrier can change during the save,
      // status read, or synchronous publication. No Start is then outstanding.
      // Preserve process/Stop/terminal evidence that replaced our local label.
      if (this.status === 'preparing' || dispatchPending && this.status === 'starting') {
        this.status = this.run.phase === 'prepared' && !this.dirty() && !this.hasCheckpointBarrier()
          && !this.pending.size && !this.hasRefusedEvidence() && (!this.mayHaveDispatched() || this.freshNotDispatched)
          ? 'idle' : 'unknown';
      }
      this.schedulePoll();
      this.publish();
    }
  }
  /** Stop bypasses saves. A timeout releases the controls, never the outstanding evidence. */
  async stop(): Promise<void> {
    if (!this.canStop()) return;
    const attempt = ++this.stopAttempt;
    const evidenceAttempt = ++this.evidenceClock;
    this.freshNotDispatched = false;
    this.unsettledStops.add(attempt);
    this.stopRequested = true;
    this.stopState = 'pending';
    this.status = 'stopping';
    await new Promise<void>((resolve) => {
      this.stopWaiters.set(attempt, resolve);
      const timer = this.scheduler.setTimeout(() => {
        this.stopTimers.delete(attempt);
        this.stopWaiters.delete(attempt);
        if (!this.disposed && attempt === this.stopAttempt && this.stopState === 'pending') {
          this.stopState = 'unknown';
          this.status = isConversationRunClosed(this.run) ? 'terminal' : 'unknown';
          this.transportError = this.interruptionReason ?? (this.contradictory ? 'event-refused' : 'stop-unknown');
          this.publish();
        }
        resolve();
      }, PARTICIPANT_STOP_TIMEOUT_MS);
      this.stopTimers.set(attempt, timer);
      const settle = (result: ParticipantStopResult) => {
        this.unsettledStops.delete(attempt);
        this.stopWaiters.delete(attempt);
        this.scheduler.clearTimeout(timer);
        this.stopTimers.delete(attempt);
        if (!this.disposed) this.receiveStopResult(result, attempt, evidenceAttempt);
        resolve();
      };
      try { const pending = this.stopPort(this.target()); this.publish(); void pending.then(settle, () => settle({ kind: 'unknown' })); }
      catch { settle({ kind: 'unknown' }); }
    });
  }
  private receiveStopResult(result: ParticipantStopResult, attempt: number, evidenceAttempt: number): void {
    if ((result?.kind === 'confirmed' || result?.kind === 'cleanup-uncertain') && this.validTerminal(result.event)) {
      const terminal = result.event;
      this.receive(terminal);
      if (evidenceAttempt >= this.cleanupEvidenceAttempt && this.matchesKnownTerminal(terminal) && result.kind === 'confirmed' && !this.terminalIncomplete(terminal)) {
        this.cleanupState = 'cleared'; this.cleanupEvidenceAttempt = evidenceAttempt;
      }
      if (evidenceAttempt >= this.cleanupEvidenceAttempt && this.matchesKnownTerminal(terminal) && this.cleanupState !== 'cleared'
        && result.kind === 'cleanup-uncertain' && typeof result.owned === 'boolean') {
        this.cleanupState = result.owned ? 'owned' : 'unowned'; this.cleanupEvidenceAttempt = evidenceAttempt;
        this.stopState = 'unknown';
      }
      // An old port's "confirmed" stop-incomplete event proves a terminal,
      // not that its process group cleared. Only separate status can settle it.
      this.confirmedProgress();
      void this.readCleanupStatus();
    }
    if (attempt === this.stopAttempt && this.stopState === 'pending') {
      this.stopState = 'unknown';
      this.status = isConversationRunClosed(this.run) ? 'terminal' : 'unknown';
      this.transportError = this.interruptionReason ?? (this.contradictory ? 'event-refused' : 'stop-unknown');
    }
    this.publish();
  }
  /** Explicit local closure preserves evidence; it makes no assertion about remote cancellation. */
  closeAsUnknown(): void {
    if (!this.canCloseUnknown()) return;
    const terminal = [...this.pending.values()].find((event): event is ParticipantTerminalEvent => event.type === 'stopped');
    if (terminal) { this.closeInterrupted(terminal); return; }
    const closed = closeConversationRun(this.run, { kind: 'unknown', reason: 'user-closed', at: this.closureTime() });
    if (closed.kind !== 'ok') return;
    this.run = closed.run;
    this.status = 'unknown';
    this.stopState = 'idle';
    this.transportError = null;
    this.publish();
    this.scheduleCheckpoint(true);
  }
  /** The user may leave unreachable cleanup unresolved; this is never proof of cancellation. */
  acknowledgeUnreachableCleanup(): void {
    if (!this.canAcknowledgeUnreachableCleanup()) return;
    const result = acknowledgeUnreachableCleanup(this.run, this.closureTime());
    if (result.kind !== 'ok') return;
    let admitted = false;
    try { admitted = this.acceptRun(result.run); } catch { /* An uncertain save budget is not admission. */ }
    if (!admitted) { this.transportError = 'recovery-size-limit'; this.publish(); return; }
    this.run = result.run;
    if (this.transportError === 'recovery-size-limit') this.transportError = null;
    this.publish();
    this.scheduleCheckpoint(true);
  }
  async reconcile(): Promise<void> {
    if (this.disposed || this.reconcileInFlight || !this.unsubscribe
      || (isConversationRunClosed(this.run) && !this.cleanupUnresolved()
        && !(this.recordedTerminal() && this.statusPort && this.cleanupState === 'none'))) return;
    this.reconcileInFlight = true;
    // The constructor raises the initial restore barrier. Once replay has
    // conclusively completed, a quiet poll adds no new unsaved evidence by
    // itself; actual buffered events and checkpoints keep their own barriers.
    try {
      if (this.statusPort) await this.readCleanupStatus();
      while (!this.disposed && !isConversationRunClosed(this.run)) {
        const before = this.run.lastSequence;
        const result = await this.reconcilePort(Object.freeze({ ...this.target(), afterSequence: before }));
        if (this.disposed || isConversationRunClosed(this.run)) return;
        if (result.kind === 'events' && Array.isArray(result.events)) {
          for (let i = 0; i < result.events.length; i++) {
            if (i && i % RECONCILE_BATCH_SIZE === 0) await this.scheduler.yield();
            if (this.disposed || isConversationRunClosed(this.run)) break;
            this.receive(result.events[i]);
          }
          if (!result.more || isConversationRunClosed(this.run)) {
            if (!result.more && !this.pending.size && !this.hasRefusedEvidence()) this.restoredReplayPending = false;
            break;
          }
          if (this.run.lastSequence <= before) {
            this.status = 'unknown'; this.transportError = 'reconcile-unknown'; break;
          }
          await this.scheduler.yield();
        } else if (result.kind === 'lost') { this.receiveLost(result.lost, result.terminal); break; }
        else { this.status = 'unknown'; this.transportError = 'reconcile-unknown'; break; }
      }
    } catch {
      if (!this.disposed && !isConversationRunClosed(this.run)) { this.status = 'unknown'; this.transportError = 'reconcile-unknown'; }
    } finally { this.reconcileInFlight = false; this.schedulePoll(); this.publish(); }
  }
  private receiveLost(lost: LostRange, terminal: ParticipantTerminalEvent | null): void {
    if (!lost || Object.getPrototypeOf(lost) !== Object.prototype
      || Reflect.ownKeys(lost).length !== 3
      || !['fromSequence', 'throughSequence', 'reason'].every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(lost, key);
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
      })
      || lost.fromSequence !== this.run.lastSequence + 1
      || !['locked', 'closed', 'restarted', 'replaced'].includes(lost.reason)) {
      this.status = 'unknown'; this.transportError = 'reconcile-unknown'; return;
    }
    if (terminal === null && lost.throughSequence === null) {
      this.replayLost = true; this.freshNotDispatched = false;
      this.status = 'unknown'; this.transportError = 'event-gap'; return;
    }
    if (!this.validTerminal(terminal)) { this.status = 'unknown'; this.transportError = 'reconcile-unknown'; return; }
    if ([...this.pending.values()].some((event) => isTerminalEvent(event) && eventKey(event) !== eventKey(terminal))) {
      this.latchContradiction(); return;
    }
    const result = closeConversationRun(this.run, { kind: 'interrupted', reason: 'replay-lost',
      at: this.closureTime(terminal), terminalEvent: terminal, lost });
    if (result.kind !== 'ok') { this.status = 'unknown'; this.transportError = 'reconcile-unknown'; return; }
    this.run = result.run;
    this.freshNotDispatched = false;
    if (this.terminalIncomplete(terminal)) this.cleanupState = 'unknown';
    this.confirmedProgress(); this.publish(); this.scheduleCheckpoint(true);
    void this.readCleanupStatus();
  }
  /** Explicit retry/drain; an uncertain write still forbids any new checkpoint. */
  async flush(): Promise<void> {
    if (this.disposed || this.unknownCheckpoint || (this.status === 'unavailable' && !isConversationRunClosed(this.run))) return;
    this.failedCheckpoint = null;
    this.blockedCheckpoint = null;
    this.clearTimer();
    while (!this.disposed && !this.hasCheckpointBarrier() && (this.dirty() || this.saveInFlight)) {
      this.immediateCheckpoint = true;
      await this.writeCheckpoint();
    }
    if (!this.saveInFlight) this.immediateCheckpoint = false;
  }
  confirmCheckpoint(record: ConversationRun): boolean { return this.resolveCheckpoint({ kind: 'saved', record }); }
  resolveCheckpoint(result: CheckpointResolution): boolean {
    const attempted = this.unknownCheckpoint ?? this.failedCheckpoint ?? this.blockedCheckpoint;
    if (this.disposed || !attempted || !sameRun(attempted, result.record)
      || (result.kind !== 'saved' && result.kind !== 'not-saved')) return false;
    if (result.kind === 'saved') this.setSaved(attempted);
    this.unknownCheckpoint = null;
    this.blockedCheckpoint = null;
    this.failedCheckpoint = result.kind === 'not-saved' ? attempted : null;
    this.refreshPreparedStatus();
    this.publish();
    if (result.kind === 'saved') this.scheduleCheckpoint(isConversationRunClosed(this.run));
    return true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = 'disposed';
    this.clearTimer();
    for (const timer of this.stopTimers.values()) this.scheduler.clearTimeout(timer);
    this.stopTimers.clear();
    for (const resolve of this.stopWaiters.values()) resolve();
    this.stopWaiters.clear();
    this.clearPoll();
    this.cleanupStatusCancel?.();
    this.cleanupStatusCancel = null;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    try { unsubscribe?.(); } catch { /* Late callbacks also check disposed. */ }
    this.publish();
    this.listeners.clear();
  }
  private target(): ParticipantTarget { return Object.freeze({ runId: this.run.runId, sessionId: this.run.sessionId }); }
  private canPrepareStart(includeGlobalPolicy = true): boolean {
    let available = false;
    try { available = this.startAvailable() && (!includeGlobalPolicy || this.canDispatch()); } catch { /* Unknown availability cannot dispatch. */ }
    return available && !this.disposed && this.unsubscribe !== null && (!this.dispatched || this.freshNotDispatched)
      && (!this.startRequiresStatus || this.freshNotDispatched) && this.startRefusal?.retryable !== false && !this.contradictory
      && !this.stopRequested && !this.interruptionReason && !this.pending.size && !this.restoredReplayPending && this.refusedThrough <= this.run.lastSequence
      && this.run.phase === 'prepared' && !isConversationRunClosed(this.run);
  }
  private dispatchStillAllowed(availabilityConfirmed = false): boolean {
    // Native availability is asynchronous. Keep this callback outside the wire
    // so the adapter can recheck local latches at the actual send boundary.
    try {
      return !this.disposed && this.unsubscribe !== null && !this.stopRequested && !this.contradictory
        && !this.interruptionReason && !this.pending.size && !this.restoredReplayPending && this.refusedThrough <= this.run.lastSequence
        && this.run.phase === 'prepared' && !isConversationRunClosed(this.run)
        && !this.dirty() && !this.hasCheckpointBarrier() && !this.saveInFlight
        && (availabilityConfirmed || this.startAvailable()) && this.canDispatch();
    } catch { return false; }
  }
  private mayHaveDispatched(): boolean {
    return this.mode === 'restored' || this.dispatched || this.contradictory || this.stopRequested
      || this.interruptionReason !== null || this.run.lastSequence > 0 || this.pending.size > 0;
  }
  private canStop(): boolean {
    const recoverableCleanup = this.cleanupState === 'unknown' || this.cleanupState === 'owned';
    // Preparation can outlive an abandoned Start. Stop must remain reachable
    // regardless of current availability or permission to dispatch that run.
    const preparedWithoutStart = this.run.phase === 'prepared' && !this.startOutstanding;
    return !this.disposed && this.unsubscribe !== null && (!isConversationRunClosed(this.run) || recoverableCleanup)
      && this.stopState !== 'pending' && (this.stopState !== 'confirmed' || recoverableCleanup)
      && (recoverableCleanup || preparedWithoutStart
        || this.startPreparing || this.status === 'starting' || this.mayHaveDispatched());
  }
  private canCloseUnknown(): boolean {
    const bufferedStop = [...this.pending.values()].some((event) => event.type === 'stopped');
    return !this.disposed && !isConversationRunClosed(this.run) && !this.startPreparing && this.stopState !== 'pending'
      && !this.unsettledStops.size && this.cleanupState !== 'owned'
      && (this.startRefusal?.retryable === false || this.replayLost || bufferedStop || (!this.cleanupPending()
        && (this.status === 'unavailable' || (this.stopRequested && (this.stopState === 'unknown' || this.stopState === 'confirmed')))));
  }
  private canAcknowledgeUnreachableCleanup(): boolean {
    return !this.disposed && isConversationRunClosed(this.run) && !this.run.cleanupAcknowledgment
      && this.cleanupState === 'unknown' && !this.dirty() && !this.saveInFlight && !this.hasCheckpointBarrier()
      && !this.cleanupStatusInFlight && this.stopState !== 'pending' && !this.unsettledStops.size;
  }
  private refreshPreparedStatus(): void {
    if (!this.startOutstanding && this.canPrepareStart() && !this.dirty() && !this.hasCheckpointBarrier() && !this.saveInFlight) {
      this.status = this.startPreparing ? 'preparing' : 'idle';
      if (this.transportError !== 'start-refused') this.transportError = null;
    }
  }
  private closureTime(event?: ParticipantTerminalEvent): string {
    return new Date(Math.max(this.scheduler.now(), Date.parse(this.run.updatedAt),
      this.run.closure ? Date.parse(this.run.closure.at) : 0, event ? Date.parse(event.at) : 0)).toISOString();
  }
  private receive(value: unknown): void {
    if (this.disposed || isConversationRunClosed(this.run) || this.status === 'unavailable'
      || (this.mode === 'new' && !this.attemptedStart && !this.stopRequested)) return;
    // A port can broadcast to controllers for several sessions. Establish the
    // target without evaluating accessors before malformed content can Stop it.
    if (value === null || typeof value !== 'object') return;
    try {
      const runId = Object.getOwnPropertyDescriptor(value, 'runId');
      const sessionId = Object.getOwnPropertyDescriptor(value, 'sessionId');
      if (!runId || !Object.hasOwn(runId, 'value') || runId.value !== this.run.runId
        || !sessionId || !Object.hasOwn(sessionId, 'value') || sessionId.value !== this.run.sessionId) return;
    } catch { return; }
    if (!validateParticipantEvent(value)) { this.refuseEvent('event-refused'); return; }
    this.freshNotDispatched = false;
    this.schedulePoll(true);
    if (this.notStarted && !(this.stopRequested && value.type === 'stopped'
      && value.sequence === 1 && value.reason === 'local-stop')) this.latchContradiction();
    if (value.sequence <= this.run.lastSequence) {
      const prior = this.recentEvents.get(value.sequence);
      // Evicted history is merely stale, never claimed to be a verified duplicate.
      if (prior !== undefined && prior !== eventKey(value)) { this.latchContradiction(); this.refuseEvent('event-refused'); }
      return;
    }
    if (isTerminalEvent(value) && this.cleanupState === 'none' && this.terminalIncomplete(value)) this.cleanupState = 'unknown';
    if (isTerminalEvent(value) && this.hasRefusedEvidence()) {
      this.closeInterrupted(value); return;
    }
    const previous = this.pending.get(value.sequence);
    if (previous && eventKey(previous) !== eventKey(value)) { this.latchContradiction(); this.refuseEvent('event-refused'); return; }
    let changed = false;
    if (!previous && value.sequence === this.run.lastSequence + 1 && !this.interruptionReason) changed = this.append(value);
    if (!changed && isTerminalEvent(value) && this.hasRefusedEvidence() && !isConversationRunClosed(this.run)) { this.closeInterrupted(value); return; }
    if (!changed && !previous) this.buffer(value);
    while (!isConversationRunClosed(this.run) && !this.interruptionReason) {
      const next = this.pending.get(this.run.lastSequence + 1);
      if (!next || !this.append(next)) break;
      this.pending.delete(next.sequence);
      this.pendingBytes -= bytes(JSON.stringify(next));
      changed = true;
    }
    // A terminal may have arrived before the replay that proves a missing
    // event must be refused. Keep that real terminal as interrupted evidence
    // rather than requiring the port to send the same terminal a second time.
    if (!isConversationRunClosed(this.run) && this.hasRefusedEvidence()) {
      const terminal = [...this.pending.values()].filter(isTerminalEvent).sort((a, b) => a.sequence - b.sequence)[0];
      if (terminal) { this.closeInterrupted(terminal); return; }
    }
    if (isConversationRunClosed(this.run) && !this.run.closure) { this.pending.clear(); this.pendingBytes = 0; this.refusedThrough = 0; }
    this.confirmedProgress();
    this.publish();
    if (changed) this.scheduleCheckpoint(isConversationRunClosed(this.run));
    if (isTerminalEvent(value)) void this.readCleanupStatus();
  }
  private append(event: ParticipantEvent): boolean {
    const result = appendParticipantEvent(this.run, event);
    if (result.kind !== 'ok') { this.refuseEvent('event-refused'); return false; }
    if (event.type === 'text') {
      let admitted = false;
      try { admitted = this.acceptRun(result.run); } catch { /* Budget uncertainty cannot authorize more output. */ }
      if (!admitted) { this.refuseEvent('workspace-limit'); return false; }
    }
    this.run = result.run;
    if (event.type === 'text') this.outputText += event.text;
    const key = eventKey(event);
    this.recentEvents.set(event.sequence, key);
    this.recentBytes += bytes(key);
    while (this.recentEvents.size > MAX_PENDING_PARTICIPANT_EVENTS || this.recentBytes > MAX_PENDING_PARTICIPANT_BYTES) {
      const oldest = this.recentEvents.entries().next().value!;
      this.recentEvents.delete(oldest[0]); this.recentBytes -= bytes(oldest[1]);
    }
    return true;
  }
  private buffer(event: ParticipantEvent): void {
    const size = bytes(JSON.stringify(event));
    if (this.pending.size >= MAX_PENDING_PARTICIPANT_EVENTS || this.pendingBytes + size > MAX_PENDING_PARTICIPANT_BYTES) {
      this.refusedThrough = Math.max(this.refusedThrough, event.sequence); this.refuseEvent('event-refused'); return;
    }
    this.pending.set(event.sequence, Object.freeze({ ...event }));
    this.pendingBytes += size;
  }
  private latchContradiction(): void { this.contradictory = true; this.status = 'unknown'; this.transportError = 'event-refused'; this.publish(); }
  private hasRefusedEvidence(): boolean { return !!this.interruptionReason || this.contradictory || this.refusedThrough > this.run.lastSequence; }
  private refuseEvent(reason: 'event-refused' | 'workspace-limit'): void {
    this.interruptionReason ??= reason;
    this.status = 'unknown'; this.transportError = reason; this.publish();
    this.requestAutomaticStop();
  }
  private requestAutomaticStop(): void {
    if (this.interruptionReason && !this.automaticStopRequested && this.canStop()) {
      this.automaticStopRequested = true; void this.stop();
    }
  }
  private closeInterrupted(event: ParticipantTerminalEvent): void {
    const result = closeConversationRun(this.run, { kind: 'interrupted', reason: this.interruptionReason ?? 'event-refused',
      at: this.closureTime(event), terminalEvent: event });
    if (result.kind !== 'ok') { this.refuseEvent('event-refused'); return; }
    this.run = result.run;
    this.confirmedProgress(); this.publish(); this.scheduleCheckpoint(true);
    void this.readCleanupStatus();
  }
  private cleanupPending(): boolean {
    const acknowledged = this.run.cleanupAcknowledgment && this.savedRecord?.cleanupAcknowledgment?.at === this.run.cleanupAcknowledgment.at;
    return this.cleanupState === 'owned' || (this.cleanupState === 'unknown' && !acknowledged);
  }
  private cleanupUnresolved(): boolean { return this.cleanupState === 'unknown' || this.cleanupState === 'owned' || this.cleanupState === 'unowned'; }
  private terminalIncomplete(event: ParticipantTerminalEvent | undefined): boolean {
    return !!event && 'reason' in event && event.reason === 'stop-incomplete';
  }
  private recordedTerminal(): ParticipantTerminalEvent | undefined {
    if (this.run.closure?.kind === 'interrupted') return this.run.closure.terminalEvent;
    if (this.run.phase !== 'stopped' && this.run.phase !== 'failed' && this.run.phase !== 'completed') return;
    return { ...this.target(), sequence: this.run.lastSequence, at: this.run.updatedAt, type: this.run.phase,
      ...('reason' in this.run ? { reason: this.run.reason } : {}) } as ParticipantTerminalEvent;
  }
  private validTerminal(event: unknown): event is ParticipantTerminalEvent {
    return validateParticipantEvent(event) && isTerminalEvent(event) && event.runId === this.run.runId && event.sessionId === this.run.sessionId;
  }
  private validStatusTerminal(event: unknown): event is ParticipantTerminalEvent {
    if (this.validTerminal(event)) return true;
    // Old saved records allowed stopped/paid-overflow. They remain readable,
    // and a status response may correlate that exact existing evidence. This
    // exception never admits a new event or a Stop response into the run.
    if (this.mode !== 'restored' || !isConversationRunClosed(this.run) || !event || typeof event !== 'object') return false;
    try {
      const descriptors = Object.getOwnPropertyDescriptors(event);
      if (descriptors.type?.value !== 'stopped' || descriptors.reason?.value !== 'paid-overflow') return false;
      const normalized = Object.create(Object.getPrototypeOf(event), { ...descriptors,
        reason: { ...descriptors.reason, value: 'local-stop' } });
      return this.validTerminal(normalized) && this.matchesKnownTerminal(event as ParticipantTerminalEvent);
    } catch { return false; }
  }
  private matchesKnownTerminal(event: ParticipantTerminalEvent): boolean {
    const recorded = this.recordedTerminal();
    const pending = this.pending.get(event.sequence);
    if (!recorded) return !!pending && eventKey(pending) === eventKey(event);
    if (this.run.closure?.kind === 'interrupted') return eventKey(recorded) === eventKey(event);
    const exactEvent = this.recentEvents.get(event.sequence);
    if (exactEvent) return exactEvent === eventKey(event);
    // Schema 1 stores logical updatedAt, not the terminal's own possibly skewed
    // clock. All persisted terminal evidence still has to correlate exactly.
    return recorded.runId === event.runId && recorded.sessionId === event.sessionId && recorded.sequence === event.sequence
      && recorded.type === event.type && ('reason' in recorded ? recorded.reason : undefined) === ('reason' in event ? event.reason : undefined)
      && event.at <= this.run.updatedAt;
  }
  private async readCleanupStatus(): Promise<void> {
    if (!this.statusPort || this.cleanupStatusInFlight || this.disposed) return;
    this.cleanupStatusInFlight = true;
    const attempt = ++this.evidenceClock;
    const startEpoch = this.startEvidenceEpoch;
    const duringStart = this.startPortOutstanding;
    let timer: unknown;
    try {
      const read = this.statusPort(this.target()).then((result) => {
        // A read concurrent with the adapter's availability/start await may
        // honestly see the old not-dispatched state. It cannot authorize a
        // retry or contradict the Start, even if it resolves after Start does.
        const staleNotDispatched = result.kind === 'status' && result.state === 'not-dispatched'
          && (duringStart || this.startPortOutstanding || startEpoch !== this.startEvidenceEpoch);
        if (!staleNotDispatched && attempt >= this.cleanupEvidenceAttempt && this.receiveStatus(result)) this.cleanupEvidenceAttempt = attempt;
        // A timed-out check may still reveal an owned group after the user has
        // acknowledged uncertainty, unless a newer check supplied evidence.
        // A newer unknown result is not evidence that discards the older read.
        if (!this.disposed) this.publish();
      });
      await Promise.race([read, new Promise<void>((resolve) => {
        this.cleanupStatusCancel = resolve;
        timer = this.scheduler.setTimeout(this.cleanupStatusCancel, PARTICIPANT_STOP_TIMEOUT_MS);
      })]);
    } catch { /* A failed check never releases owned cleanup or rewrites the terminal. */ }
    finally {
      if (timer !== undefined) this.scheduler.clearTimeout(timer);
      this.cleanupStatusInFlight = false;
      this.cleanupStatusCancel = null;
      if (!this.disposed) { this.schedulePoll(); this.publish(); }
    }
  }
  private receiveStatus(result: ParticipantStatusResult): boolean {
    if (this.disposed || result?.kind !== 'status') return false;
    if (result.terminal !== null) {
      if (!this.validStatusTerminal(result.terminal)) return false;
      // Status can be ahead of the saved prefix. Buffer the terminal while
      // events replay; it does not prove that missing text was lost.
      this.receive(result.terminal);
      return this.receiveCleanupStatus(result);
    }
    if (isConversationRunClosed(this.run) || result.groupCleared !== null) return false;
    if (result.state === 'not-dispatched' && result.lastSequence === 0 && result.unknownReason === null) {
      if (this.run.lastSequence || this.pending.size || this.hasRefusedEvidence() || this.stopRequested
        || this.dispatched && !this.startRequiresStatus) {
        this.freshNotDispatched = false;
        if (this.run.lastSequence || this.pending.size || this.dispatched && !this.startRequiresStatus) this.latchContradiction();
      } else {
        this.freshNotDispatched = true;
        this.status = 'idle';
        if (this.transportError === 'start-unknown') this.transportError = null;
      }
      return true;
    }
    this.freshNotDispatched = false;
    if (['starting', 'running', 'stopping'].includes(result.state) && result.unknownReason === null) {
      this.status = result.state as 'starting' | 'running' | 'stopping'; return true;
    }
    if (result.state === 'unknown') { this.status = 'unknown'; return false; }
    return false;
  }
  private shouldPoll(): boolean {
    return !this.disposed && !!this.statusPort && this.unsubscribe !== null
      && ((!isConversationRunClosed(this.run) && (this.mode === 'restored' || this.attemptedStart || this.stopRequested))
        || this.cleanupUnresolved() || (!!this.recordedTerminal() && this.cleanupState === 'none'));
  }
  private clearPoll(): void {
    if (this.pollTimer !== null) { this.scheduler.clearTimeout(this.pollTimer); this.pollTimer = null; }
  }
  private schedulePoll(reset = false): void {
    if (reset || !this.shouldPoll()) this.clearPoll();
    if (!this.shouldPoll() || this.pollTimer !== null || this.reconcileInFlight || this.cleanupStatusInFlight) return;
    this.pollTimer = this.scheduler.setTimeout(() => { this.pollTimer = null; void this.reconcile(); }, PARTICIPANT_QUIET_POLL_MS);
  }
  private receiveCleanupStatus(result: ParticipantStatusResult): boolean {
    if (this.disposed || this.cleanupState === 'cleared' || result?.kind !== 'status' || !this.validStatusTerminal(result.terminal)
      || !this.matchesKnownTerminal(result.terminal) || result.lastSequence !== result.terminal.sequence
      || result.unknownReason !== null || (this.terminalIncomplete(result.terminal) && result.groupCleared === null)) return false;
    if (result.state === 'cleanup-pending' && result.groupCleared === false) this.cleanupState = 'owned';
    else if (result.state === 'exited' && (result.groupCleared === true || result.groupCleared === false || result.groupCleared === null)) {
      this.cleanupState = result.groupCleared === false ? 'unowned' : 'cleared';
    } else return false;
    this.confirmedProgress();
    return true;
  }
  private confirmedProgress(): void {
    const stopped = this.recordedTerminal() ?? [...this.pending.values()].find((event) => event.type === 'stopped');
    if (stopped?.type === 'stopped' && !this.terminalIncomplete(stopped) && !this.cleanupPending()) this.stopState = 'confirmed';
    if (isConversationRunClosed(this.run)) {
      this.status = this.run.closure?.kind === 'unknown' ? 'unknown' : 'terminal';
      if (this.cleanupState === 'unknown' || this.cleanupState === 'owned' || this.cleanupState === 'unowned') {
        if (this.stopState !== 'pending') this.stopState = 'unknown';
      } else if (stopped?.type === 'stopped') this.stopState = 'confirmed';
      else this.stopState = 'idle';
      this.transportError = null;
    } else if (this.hasRefusedEvidence()) {
      this.status = 'unknown'; this.transportError = this.interruptionReason ?? 'event-refused';
    } else if (this.pending.size) {
      this.status = 'unknown'; this.transportError = 'event-gap';
    } else if (this.stopState === 'unknown') { this.status = 'unknown'; this.transportError = 'stop-unknown'; }
    else { this.transportError = null; this.status = this.stopRequested ? 'stopping' : this.run.phase === 'prepared' ? 'idle' : 'running'; }
  }
  private dirty(): boolean { return this.savedRecord === null || !sameRun(this.run, this.savedRecord); }
  private hasCheckpointBarrier(): boolean { return !!(this.unknownCheckpoint || this.failedCheckpoint || this.blockedCheckpoint); }
  private setSaved(record: ConversationRun): void { this.savedRecord = record; this.persistedPrefix = record.outputChunks.join(''); }
  private clearTimer(): void { if (this.timer !== null) { this.scheduler.clearTimeout(this.timer); this.timer = null; } }
  private scheduleCheckpoint(immediate = false): void {
    if (this.disposed || (this.status === 'unavailable' && !isConversationRunClosed(this.run)) || this.hasCheckpointBarrier() || !this.dirty()) return;
    if (immediate) { this.immediateCheckpoint = true; this.clearTimer(); }
    if (this.saveInFlight) return;
    if (this.immediateCheckpoint) {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => { this.scheduled = false; void this.writeCheckpoint(); });
    } else if (this.timer === null) {
      this.timer = this.scheduler.setTimeout(() => { this.timer = null; void this.writeCheckpoint(); },
        Math.max(0, this.lastCheckpointAt + RUN_CHECKPOINT_INTERVAL_MS - this.scheduler.now()));
    }
  }
  private writeCheckpoint(): Promise<void> {
    if (this.saveInFlight) return this.saveInFlight;
    if (this.disposed || (this.status === 'unavailable' && !isConversationRunClosed(this.run)) || this.hasCheckpointBarrier() || !this.dirty()) return Promise.resolve();
    this.clearTimer();
    this.immediateCheckpoint = false;
    const work = Promise.resolve().then(async () => {
      if (this.disposed || (this.status === 'unavailable' && !isConversationRunClosed(this.run)) || this.hasCheckpointBarrier()) return;
      const attempted = this.run;
      this.lastCheckpointAt = this.scheduler.now();
      let result: RunCheckpointResult;
      try { result = await this.checkpoint(attempted); } catch { result = { kind: 'unknown' }; }
      if (this.disposed) return;
      if (result?.kind === 'saved' && sameRun(attempted, result.record)) this.setSaved(attempted);
      else if (result?.kind === 'not-saved') this.failedCheckpoint = attempted;
      else if (result?.kind === 'blocked') this.blockedCheckpoint = attempted;
      else this.unknownCheckpoint = attempted;
      this.publish();
    }).finally(() => {
      this.saveInFlight = null;
      this.refreshPreparedStatus();
      this.publish();
      // An event can arrive after the ACK but before this finalizer releases the writer.
      this.scheduleCheckpoint(this.immediateCheckpoint || isConversationRunClosed(this.run));
    });
    this.saveInFlight = work;
    this.publish();
    return work;
  }
  private publish(): void {
    if (!this.listeners.size) return;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) { try { listener(snapshot); } catch { /* Observers do not own transport or persistence. */ } }
  }
}
