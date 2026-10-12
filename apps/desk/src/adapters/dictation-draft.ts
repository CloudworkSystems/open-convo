import { applyCommand } from '../domain/commands';
import type { DeskState, DomainOptions } from '../domain/types';
import type { NativeDocumentContext } from './native-host-client';

/** Internal capture metadata, not a native message schema or authentication. */
export interface DictationDraftTarget extends NativeDocumentContext {
  readonly workspaceHandle: string;
  readonly sessionId: string;
}

/** Textarea selection offsets use UTF-16 code units. */
export interface DictationDraftSelection {
  readonly start: number;
  readonly end: number;
}

type ConflictReason = 'target-changed' | 'draft-changed' | 'workspace-changed' | 'selection-changed';
type RefusalReason = 'revoked' | 'invalid-delivery' | 'identity-reused' | 'already-delivered' | 'command-refused';
export type DictationDraftResult =
  | { readonly kind: 'applied-in-memory'; readonly persistence: 'unconfirmed'; readonly deliveryId: string;
      readonly state: DeskState; readonly expectedRevision: number; readonly revision: number;
      readonly selection: DictationDraftSelection }
  | { readonly kind: 'duplicate'; readonly persistence: 'unconfirmed'; readonly deliveryId: string;
      readonly original: 'applied-in-memory' | 'conflict' | 'refused' }
  | { readonly kind: 'conflict'; readonly reason: ConflictReason }
  | { readonly kind: 'refused'; readonly reason: RefusalReason };

type Capture = {
  readonly target: DictationDraftTarget;
  readonly text: string;
  readonly revision: number;
  readonly selection: DictationDraftSelection;
};

const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validTarget = (target: DictationDraftTarget) => hasText(target.connectionId) && hasText(target.workspaceHandle)
  && hasText(target.sessionId) && Number.isSafeInteger(target.documentGeneration) && target.documentGeneration >= 0;
const sameTarget = (a: DictationDraftTarget, b: DictationDraftTarget) => a.connectionId === b.connectionId
  && a.documentGeneration === b.documentGeneration && a.workspaceHandle === b.workspaceHandle && a.sessionId === b.sessionId;
const splitsSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length
  && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
  && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
const validSelection = (selection: DictationDraftSelection, text: string) => Number.isSafeInteger(selection.start)
  && Number.isSafeInteger(selection.end) && selection.start >= 0 && selection.end >= selection.start
  && selection.end <= text.length && !splitsSurrogate(text, selection.start) && !splitsSurrogate(text, selection.end);

/**
 * One ephemeral recording target using the existing Desk draft command. No App,
 * native transport, provider, keyboard event or durable storage is connected.
 * The current DeskState is the invented proof schema, not protected history.
 *
 * Capture at recording start. The integration must invalidate on target change,
 * composer closure, lock or navigation, even if the user later returns to the
 * same session: a comparison at delivery cannot detect an intervening switch.
 * The native authority must independently enforce its binding and delivery IDs.
 *
 * There is no per-draft revision in DeskState. This proof conservatively refuses
 * any intervening workspace revision, including unrelated edits. It does not
 * invent a persistent draft revision or a durable deduplication ledger.
 */
export class CapturedDictationDraft {
  private capture: Capture | undefined;
  private delivery: { id: string; text: string; outcome: 'applied-in-memory' | 'conflict' | 'refused' } | undefined;

  constructor(state: DeskState, target: DictationDraftTarget, selection: DictationDraftSelection) {
    const text = state.drafts[target.sessionId];
    if (!validTarget(target) || !state.sessions.some((session) => session.id === target.sessionId)
      || state.selection.sessionId !== target.sessionId || typeof text !== 'string'
      || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER
      || !validSelection(selection, text)) throw new TypeError('The dictation draft target cannot be captured.');
    this.capture = Object.freeze({
      target: Object.freeze({ connectionId: target.connectionId, documentGeneration: target.documentGeneration,
        workspaceHandle: target.workspaceHandle, sessionId: target.sessionId }),
      text, revision: state.revision, selection: Object.freeze({ start: selection.start, end: selection.end }),
    });
  }

  /** Revoke permanently and clear this binding's retained text. */
  invalidate(): void {
    this.capture = undefined;
    this.delivery = undefined;
  }

  /**
   * Return one in-memory candidate. The caller must commit it at expectedRevision
   * and report the independently validated durable result. Returning this value,
   * receiving the same delivery again or dispatching a save is never a save ACK.
   * A conflict/refusal leaves state untouched; explicit insertion is a separate
   * user action, never an automatic rebind or append to a different draft.
   */
  deliver(
    state: DeskState,
    currentTarget: DictationDraftTarget,
    currentSelection: DictationDraftSelection,
    deliveryId: string,
    literalText: string,
    options: DomainOptions = {},
  ): DictationDraftResult {
    const capture = this.capture;
    if (!capture) return { kind: 'refused', reason: 'revoked' };
    if (!hasText(deliveryId) || !hasText(literalText)) return { kind: 'refused', reason: 'invalid-delivery' };
    if (this.delivery) {
      if (this.delivery.id !== deliveryId) return { kind: 'refused', reason: 'already-delivered' };
      if (this.delivery.text !== literalText) return { kind: 'refused', reason: 'identity-reused' };
      return { kind: 'duplicate', persistence: 'unconfirmed', deliveryId, original: this.delivery.outcome };
    }
    this.delivery = { id: deliveryId, text: literalText, outcome: 'refused' };
    const conflict = (reason: ConflictReason): DictationDraftResult => {
      this.delivery!.outcome = 'conflict';
      return { kind: 'conflict', reason };
    };
    if (!validTarget(currentTarget) || !sameTarget(capture.target, currentTarget)
      || state.selection.sessionId !== capture.target.sessionId
      || !state.sessions.some((session) => session.id === capture.target.sessionId)) return conflict('target-changed');
    if (state.drafts[capture.target.sessionId] !== capture.text) return conflict('draft-changed');
    if (state.revision !== capture.revision) return conflict('workspace-changed');
    if (!validSelection(currentSelection, capture.text) || currentSelection.start !== capture.selection.start
      || currentSelection.end !== capture.selection.end) return conflict('selection-changed');
    const text = capture.text.slice(0, capture.selection.start) + literalText + capture.text.slice(capture.selection.end);
    let next: DeskState;
    try {
      next = applyCommand(state, { type: 'set-draft', sessionId: capture.target.sessionId, text, expectedText: capture.text }, options);
    } catch {
      return { kind: 'refused', reason: 'command-refused' };
    }
    if (this.capture !== capture || !this.delivery) return { kind: 'refused', reason: 'revoked' };
    this.delivery.outcome = 'applied-in-memory';
    const caret = capture.selection.start + literalText.length;
    return { kind: 'applied-in-memory', persistence: 'unconfirmed', deliveryId, state: next,
      expectedRevision: capture.revision, revision: next.revision, selection: Object.freeze({ start: caret, end: caret }) };
  }
}
