import type { DeskState } from '../domain/types';
import { CapturedDictationDraft, type DictationDraftSelection, type DictationDraftTarget } from './dictation-draft';
import type { NativeDocumentContext, NativeHostClient } from './native-host-client';
import type { NativeProofRequest, NativeProofResult } from './native-host-codec';

type Client = NativeHostClient<NativeProofRequest, NativeProofResult>;
type Events = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * What the composer offers as a dictation target. The App supplies it only
 * while the draft field is focused, the workspace is unlocked and every edit
 * is saved, so the bound revision is the native host's committed revision.
 */
export interface DictationComposerTarget {
  readonly state: DeskState;
  readonly sessionId: string;
  readonly selection: DictationDraftSelection;
}

export type DictationLaneStatus = 'off' | 'binding' | 'ready' | 'unavailable';

/** A pushed final. `capture` is absent when its binding is no longer known here. */
export interface DictationFinal {
  readonly deliveryId: string;
  readonly text: string;
  readonly capture?: CapturedDictationDraft;
  readonly target?: DictationDraftTarget;
}

export interface NativeDictationLaneOptions {
  readonly client: Client;
  readonly context: NativeDocumentContext;
  readonly workspaceHandle: string;
  readonly events: Events;
  readonly requestId: () => string;
  /** Delay before binding a new target, so typing does not bind per keystroke. */
  readonly settleMs?: number;
  readonly onRevoked?: () => void;
}

type Bound = { readonly bindingId: string; readonly key: string; readonly capture: CapturedDictationDraft; readonly target: DictationDraftTarget };
type Desired = { readonly key: string; readonly composer: DictationComposerTarget };

const uuid4 = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const keyFor = (target: DictationComposerTarget) => JSON.stringify([target.sessionId, target.state.revision,
  target.selection.start, target.selection.end, target.state.drafts[target.sessionId] ?? null]);
/** Recently replaced bindings whose late finals can still be matched to their own capture. */
const RECENT_LIMIT = 4;

/**
 * Keeps one native draft binding current for the focused composer, before any
 * recording starts: the Mac reads only an existing binding when recording
 * begins, so the Desk must already have one, confirmed by the bind reply.
 *
 * Binds after the target settles; unbinds immediately when the target goes
 * away (blur, lock, navigation, unsaved edits). Each workspace revision is a
 * new target, so an unrelated save rebinds instead of leaving a stale one.
 * Requests run one at a time on this lane's own client, so bind and unbind
 * never wait behind, or block, workspace saves.
 *
 * Finals and receipts arrive as `trueconvo-host` events. This lane only
 * matches a final to its binding's capture; the App applies, saves and
 * keeps any text it could not place. Revocation clears every capture.
 */
export class NativeDictationLane {
  private active = true;
  private desired: Desired | null = null;
  private bound: Bound | null = null;
  private readonly recent = new Map<string, Bound>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed = false;
  private readonly statusListeners = new Set<() => void>();
  private readonly finalListeners = new Set<(final: DictationFinal) => void>();
  private readonly receiptListeners = new Set<(deliveryId: string) => void>();
  private readonly settleMs: number;

  constructor(private readonly options: NativeDictationLaneOptions) {
    if (!options || !options.client || !options.context || typeof options.workspaceHandle !== 'string'
      || !options.workspaceHandle || typeof options.requestId !== 'function'
      || typeof options.events?.addEventListener !== 'function') throw new TypeError('The dictation lane configuration is invalid.');
    this.settleMs = options.settleMs ?? 150;
    if (!Number.isSafeInteger(this.settleMs) || this.settleMs < 0) throw new TypeError('The dictation lane configuration is invalid.');
    options.events.addEventListener('trueconvo-host', this.receive);
  }

  get status(): DictationLaneStatus {
    if (!this.active || this.failed) return 'unavailable';
    if (this.bound && this.desired && this.bound.key === this.desired.key) return 'ready';
    return this.desired ? 'binding' : 'off';
  }

  subscribe(changed: () => void): () => void {
    if (!this.active) return () => {};
    this.statusListeners.add(changed);
    return () => { this.statusListeners.delete(changed); };
  }

  onFinal(listener: (final: DictationFinal) => void): () => void {
    this.finalListeners.add(listener);
    return () => { this.finalListeners.delete(listener); };
  }

  onReceipt(listener: (deliveryId: string) => void): () => void {
    this.receiptListeners.add(listener);
    return () => { this.receiptListeners.delete(listener); };
  }

  /** Offer the composer target, or null when dictation must not land anywhere. */
  setTarget(target: DictationComposerTarget | null): void {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!target) {
      if (!this.desired) return;
      this.desired = null;
      this.changed();
      void this.run();
      return;
    }
    const key = keyFor(target);
    if (this.desired?.key === key) return;
    // The old binding must not receive text for a target that no longer exists.
    this.desired = null;
    this.changed();
    void this.run();
    const next: Desired = { key, composer: target };
    const settle = () => {
      this.timer = undefined;
      if (!this.active) return;
      this.desired = next;
      this.changed();
      void this.run();
    };
    if (this.settleMs === 0) settle();
    else this.timer = setTimeout(settle, this.settleMs);
  }

  revoke(): void {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.desired = null;
    this.bound = null;
    this.recent.clear();
    try { this.options.events.removeEventListener('trueconvo-host', this.receive); } catch { /* Revocation stays final. */ }
    this.changed();
    this.statusListeners.clear();
    this.finalListeners.clear();
    this.receiptListeners.clear();
    try { this.options.onRevoked?.(); } catch { /* Local state is already cleared. */ }
  }

  private changed(): void {
    for (const listener of [...this.statusListeners]) {
      try { listener(); } catch { /* One view cannot stop another. */ }
    }
  }

  /** One request at a time until the bound target matches the desired one. */
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.active && !this.failed) {
        const desired = this.desired;
        if (this.bound && this.bound.key !== desired?.key) {
          if (!await this.unbind(this.bound)) break;
          continue;
        }
        if (desired && !this.bound) {
          if (!await this.bind(desired)) break;
          continue;
        }
        break;
      }
    } finally {
      this.running = false;
    }
  }

  private retire(bound: Bound): void {
    this.recent.delete(bound.bindingId);
    this.recent.set(bound.bindingId, bound);
    while (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.keys().next().value!);
  }

  private async unbind(bound: Bound): Promise<boolean> {
    const outcome = await this.options.client.request({ requestId: this.options.requestId(),
      operation: 'dictation.unbindDraft', payload: { bindingId: bound.bindingId } });
    if (!this.active) return false;
    // A consumed or already unknown binding is gone either way.
    const gone = outcome.kind === 'completed' && (outcome.result.outcome === 'ok'
      || outcome.result.outcome === 'refused' && outcome.result.reason === 'unknown-binding');
    if (!gone) { this.fail(); return false; }
    if (this.bound === bound) this.bound = null;
    this.retire(bound);
    this.changed();
    return true;
  }

  private async bind(desired: Desired): Promise<boolean> {
    const { state, sessionId, selection } = desired.composer;
    const target: DictationDraftTarget = { connectionId: this.options.context.connectionId,
      documentGeneration: this.options.context.documentGeneration, workspaceHandle: this.options.workspaceHandle, sessionId };
    let capture: CapturedDictationDraft;
    try { capture = new CapturedDictationDraft(state, target, selection); }
    catch {
      // Not a bindable draft (no session, odd selection): offer nothing.
      if (this.desired === desired) { this.desired = null; this.changed(); }
      return true;
    }
    const outcome = await this.options.client.request({ requestId: this.options.requestId(), operation: 'dictation.bindDraft',
      payload: { workspaceHandle: this.options.workspaceHandle, sessionId, expectedRevision: state.revision,
        expectedText: state.drafts[sessionId] ?? '', selection: { start: selection.start, end: selection.end } } });
    if (!this.active) { capture.invalidate(); return false; }
    if (outcome.kind !== 'completed' || outcome.result.operation !== 'dictation.bindDraft' || outcome.result.outcome !== 'ok'
      || !uuid4(outcome.result.bindingId) || outcome.result.revision !== state.revision) {
      capture.invalidate();
      this.fail();
      return false;
    }
    this.bound = { bindingId: outcome.result.bindingId, key: desired.key, capture, target };
    this.changed();
    return true;
  }

  /** An uncertain bind or unbind leaves this lane unusable for the visit. */
  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.desired = null;
    this.changed();
  }

  private readonly receive: EventListener = (event) => {
    if (!this.active) return;
    let detail: unknown;
    try { detail = (event as CustomEvent<unknown>).detail; } catch { return; }
    if (!plain(detail) || detail.connectionId !== this.options.context.connectionId
      || detail.generation !== this.options.context.documentGeneration) return;
    if (detail.type === 'host.connection') {
      if (exactKeys(detail, ['type', 'connectionId', 'generation', 'state', 'reason'])
        && (detail.state === 'locked' || detail.state === 'revoked')) this.revoke();
      return;
    }
    if (detail.type === 'dictation.final') {
      if (!exactKeys(detail, ['type', 'connectionId', 'generation', 'bindingId', 'deliveryId', 'text'])
        || !uuid4(detail.bindingId) || !uuid4(detail.deliveryId)
        || typeof detail.text !== 'string' || !detail.text.length) return;
      const owner = this.bound?.bindingId === detail.bindingId ? this.bound : this.recent.get(detail.bindingId);
      // A binding takes one delivery; the next dictation needs a fresh binding.
      // The App's next target (after applying and saving) rebinds; until then nothing is offered.
      if (owner && owner === this.bound) { this.bound = null; this.desired = null; this.retire(owner); this.changed(); }
      const final: DictationFinal = { deliveryId: detail.deliveryId, text: detail.text,
        ...(owner ? { capture: owner.capture, target: owner.target } : {}) };
      for (const listener of [...this.finalListeners]) {
        try { listener(final); } catch { /* The App keeps text it could not place; one failed view stops nothing. */ }
      }
      return;
    }
    if (detail.type === 'dictation.receipt') {
      if (!exactKeys(detail, ['type', 'connectionId', 'generation', 'deliveryId', 'commitRequestId', 'revision'])
        || !uuid4(detail.deliveryId) || !uuid4(detail.commitRequestId) || !Number.isSafeInteger(detail.revision)) return;
      for (const listener of [...this.receiptListeners]) {
        try { listener(detail.deliveryId as string); } catch { /* Receipts are advisory to the view. */ }
      }
    }
  };
}
