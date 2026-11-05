import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DictationDraftSelection } from '../adapters/dictation-draft';
import type { DictationFinal, DictationLaneStatus } from '../adapters/native-dictation';
import type { WorkspaceSaveOptions } from '../adapters/workspace-repository';
import type { WorkspaceAttemptResult } from './use-conversation-runs';
import type { DeskRuntime } from './runtime';
import type { DeskState } from '../domain/types';

/** Dictated text the Desk is holding: being saved, or not placed and waiting for the owner. */
export interface RetainedDictation {
  readonly deliveryId: string;
  readonly text: string;
  readonly state: 'saving' | 'not-placed' | 'save-failed';
  /** For save-failed: which workspace problem it is, so the notice names an action that exists. */
  readonly reason?: 'retry' | 'reconcile' | 'reload';
}

const reasonFor = (kind: string): RetainedDictation['reason'] =>
  kind === 'failed' || kind === 'blocked' ? 'retry' : kind === 'unknown' ? 'reconcile' : 'reload';

export interface DeskDictationView {
  readonly status: DictationLaneStatus | 'none';
  readonly retained: readonly RetainedDictation[];
  /** Caret to restore after dictated text lands in this session's draft. */
  readonly caret?: { readonly sessionId: string; readonly position: number; readonly nonce: number };
  /** `sessionId` is null for a blank session: dictation then starts the session, as typing does. */
  reportComposer(sessionId: string | null, selection: DictationDraftSelection | null): void;
  dismiss(deliveryId: string): void;
}

export const DeskDictationContext = createContext<DeskDictationView | null>(null);
export function useDeskDictationView(): DeskDictationView | null { return useContext(DeskDictationContext); }

export interface DeskDictationAccess {
  readonly runtime: DeskRuntime;
  readonly state: DeskState | null;
  /** Re-evaluated when this changes (save status changes when a queue settles). */
  readonly settleSignal: unknown;
  current(): DeskState | null;
  /** True only when every edit is saved and no save needs attention. */
  settled(): boolean;
  blocked(): boolean;
  present(next: DeskState): void;
  save(next: DeskState, options: WorkspaceSaveOptions): Promise<WorkspaceAttemptResult>;
}

const noLane = () => () => {};

/**
 * Connects the native dictation lane to the App: offers the focused, saved
 * draft as the target, places pushed finals, saves them with their delivery
 * identity, and keeps any text it could not place until the owner copies,
 * inserts or dismisses it. Never moves text into another session or draft.
 */
export function useDeskDictation(access: DeskDictationAccess): DeskDictationView {
  const lane = access.runtime.dictation;
  const status = useSyncExternalStore(lane ? (listener) => lane.subscribe(listener) : noLane,
    () => lane ? lane.status : 'none');
  const [composer, setComposer] = useState<{ sessionId: string; selection: DictationDraftSelection; starts?: true } | null>(null);
  // The id a blank session's dictation would start its session under (step 2 trial, F14).
  const reservedId = useRef<string | null>(null);
  const reserveStartId = () => {
    const state = access.current();
    const taken = (id: string) => Boolean(state && (state.sessions.some((session) => session.id === id)
      || Object.hasOwn(state.drafts, id)));
    if (!reservedId.current || taken(reservedId.current)) {
      reservedId.current = access.runtime.createId ? access.runtime.createId() : crypto.randomUUID();
    }
    return reservedId.current;
  };
  const [retained, setRetained] = useState<readonly RetainedDictation[]>([]);
  const [caret, setCaret] = useState<DeskDictationView['caret']>();
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const accessRef = useRef(access);
  accessRef.current = access;

  const keep = (entry: RetainedDictation) => setRetained((items) =>
    [...items.filter((item) => item.deliveryId !== entry.deliveryId), entry]);
  const drop = (deliveryId: string) => setRetained((items) => items.filter((item) => item.deliveryId !== deliveryId));

  // Offer a target only when the draft is focused and the workspace is fully saved.
  useEffect(() => {
    if (!lane) return;
    const state = access.current();
    if (!composer || !state || !access.settled() || access.blocked()
      || state.selection.sessionId !== (composer.starts ? null : composer.sessionId)
      || (composer.starts && state.sessions.some((session) => session.id === composer.sessionId))) { lane.setTarget(null); return; }
    lane.setTarget({ state, sessionId: composer.sessionId, selection: composer.selection });
  }, [lane, composer, access.state, access.settleSignal]);

  useEffect(() => {
    if (!lane) return;
    const offFinal = lane.onFinal((final: DictationFinal) => {
      const { runtime, current, blocked, present, save } = accessRef.current;
      const state = current();
      const focus = composerRef.current;
      // Text kept unplaced is never committed under this delivery, so its binding can go.
      const unplaced = () => {
        keep({ deliveryId: final.deliveryId, text: final.text, state: 'not-placed' });
        lane.release(final.deliveryId);
      };
      if (!final.capture || !final.target || !state || blocked()) { unplaced(); return; }
      // A selection mismatch (focus moved, caret moved) is a conflict, never a retarget.
      const selection = focus && focus.sessionId === final.target.sessionId ? focus.selection : { start: -1, end: -1 };
      const result = final.capture.deliver(state, final.target, selection, final.deliveryId, final.text,
        runtime.createId ? { id: runtime.createId } : undefined);
      if (result.kind === 'duplicate') return;
      if (result.kind !== 'applied-in-memory') { unplaced(); return; }
      keep({ deliveryId: final.deliveryId, text: final.text, state: 'saving' });
      present(result.state);
      setCaret((previous) => ({ sessionId: final.target!.sessionId, position: result.selection.start,
        nonce: (previous?.nonce ?? 0) + 1 }));
      void save(result.state, { dictationDeliveryId: final.deliveryId }).then((saved) => {
        if (saved.kind === 'saved') drop(final.deliveryId);
        else keep({ deliveryId: final.deliveryId, text: final.text, state: 'save-failed', reason: reasonFor(saved.kind) });
      }, () => keep({ deliveryId: final.deliveryId, text: final.text, state: 'save-failed', reason: 'reload' }));
    });
    // The host's receipt is the durable confirmation; text is released only then or on a saved reply.
    // A receipt after Retry also settles an earlier failed save of the same delivery.
    const offReceipt = lane.onReceipt((deliveryId) => setRetained((items) =>
      items.filter((item) => item.deliveryId !== deliveryId || item.state === 'not-placed')));
    return () => { offFinal(); offReceipt(); };
  }, [lane]);

  return {
    status, retained, caret,
    reportComposer(reported, selection) {
      const starts = reported === null;
      setComposer((previous) => {
        if (!selection) {
          const same = previous && (starts ? previous.starts === true : !previous.starts && previous.sessionId === reported);
          return same ? null : previous;
        }
        if (previous && (starts ? previous.starts === true && previous.sessionId === reservedId.current
          : !previous.starts && previous.sessionId === reported)
          && previous.selection.start === selection.start && previous.selection.end === selection.end) return previous;
        const sessionId = starts ? reserveStartId() : reported;
        return { sessionId, selection: { start: selection.start, end: selection.end }, ...(starts ? { starts: true as const } : {}) };
      });
    },
    dismiss: drop,
  };
}
