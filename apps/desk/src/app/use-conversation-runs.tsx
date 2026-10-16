import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConversationRunController, type RunCheckpointResult, type RunRuntimeError } from '../adapters/participant-runtime';
import type { WorkspaceSaveResult } from '../adapters/workspace-repository';
import { sameParticipantIdentity } from '../domain/participant-choices';
import type { ConversationRun, ParticipantIdentity } from '../domain/conversation-run-types';
import { acknowledgeUnreachableCleanup, closeConversationRun, createConversationRun, isConversationRunClosed } from '../domain/conversation-runs';
import { canAdmitConversationRun, canSaveConversationWorkspaceWithRuns, captureConversationWorkspace, prepareConversationRun, saveConversationRunCheckpoint } from '../domain/conversation-workspace';
import type { DeskState } from '../domain/types';
import { RunTranscript } from '../features/RunTranscript';
import { canRetryLocalRun, isLocalParticipant, localChoiceProblem, ollamaChoiceTitle, localStartRefusalMessage,
  selectLocalContext } from '../domain/local-participant';
import type { DeskRuntime } from './runtime';

export type WorkspaceAttemptResult = WorkspaceSaveResult | { kind: 'blocked'; error: string };
interface RunWorkspace {
  runtime: DeskRuntime;
  state: DeskState | null;
  current(): DeskState | null;
  saved(): DeskState | null;
  blocked(): boolean;
  present(state: DeskState): void;
  save(state: DeskState): Promise<WorkspaceAttemptResult>;
  error(message: string): void;
  /** Puts a message back in a session's empty composer (Retry). Never sends. */
  restoreDraft?(sessionId: string, text: string): void;
}
interface LocalClosure {
  run: ConversationRun;
  saved: ConversationRun;
  saving: boolean;
  error?: string;
}
const errors: Partial<Record<RunRuntimeError, string>> = {
  'checkpoint-unknown': 'The save outcome is unknown. Reconcile the original workspace save before sending more work.',
  'checkpoint-blocked': 'This update has not been sent to storage. Resolve the earlier workspace save to save it.',
  'checkpoint-failed': 'This response has unsaved changes. Resolve the workspace save before sending more work.',
  'start-unknown': 'Whether the participant started is unknown. Check this run; sending it again could duplicate the work.',
  'start-refused': 'The participant did not start. The prepared message is retained.',
  'stop-unknown': 'Stop has not been confirmed. Retry Stop or check this run.',
  'reconcile-unknown': 'The participant could not confirm this run. Its saved text is retained. Check again to recover its updates. To leave this response unresolved, request Stop first, then use Close as unknown if it becomes available; that keeps the saved text without confirming completion.',
  'event-refused': 'Some response updates could not be verified. The known response prefix is retained; the response may be incomplete.',
  'event-gap': 'Some response updates have not arrived. Check this run to recover the missing updates; the received prefix is retained.',
  'subscription-failed': 'The participant connection could not be opened. No new message was sent.',
  'recovery-size-limit': 'This workspace has reached its current proof storage limit. The cleanup acknowledgment was not saved. The response and recovery controls are unchanged.',
  'workspace-limit': 'This workspace reached its current proof storage limit. The retained response prefix is unchanged; Stop was requested before accepting more text.',
};
function hasRecordedTerminal(run: Readonly<ConversationRun>) {
  return ['completed', 'stopped', 'failed'].includes(run.phase) || run.closure?.kind === 'interrupted';
}
function incompleteStop(run: Readonly<ConversationRun>) {
  return run.reason === 'stop-incomplete' || run.closure?.kind === 'interrupted'
    && 'reason' in run.closure.terminalEvent && run.closure.terminalEvent.reason === 'stop-incomplete';
}

function logicalTime(state: DeskState, run?: Readonly<ConversationRun>, sessionId?: string) {
  const session = state.sessions.find((item) => item.id === (sessionId ?? run?.sessionId));
  return [new Date().toISOString(), state.updatedAt, run?.updatedAt ?? '', session?.createdAt ?? ''].sort().at(-1)!;
}
function focusStatus(button: HTMLButtonElement) {
  const status = button.closest('[data-run-controls]')?.querySelector<HTMLElement>('[data-run-status]');
  status?.focus({ preventScroll: true });
  status?.scrollIntoView({ block: 'nearest' });
}

/** One visit's controllers. All checkpoints use the application's existing save queue. */
export function useConversationRuns(options: RunWorkspace) {
  const latest = useRef(options);
  latest.current = options;
  const controllers = useRef(new Map<string, ConversationRunController>());
  const restoreAttempts = useRef(new Set<string>());
  const localClosures = useRef(new Map<string, LocalClosure>());
  const checkingSends = useRef(new Set<string>());
  const budget = useRef<{ source: DeskState; captured: DeskState } | null>(null);
  const mounted = useRef(true);
  const [, render] = useState(0);
  const [globalAnnouncement, setGlobalAnnouncement] = useState('');
  const globalStatus = useRef<HTMLParagraphElement>(null);
  const globalAction = useRef<{ runId: string; title: string; label: string } | null>(null);
  const refresh = () => { if (mounted.current && latest.current.runtime.isActive()) render((version) => version + 1); };

  function admitted(record: Readonly<ConversationRun>) {
    const state = latest.current.current();
    if (!state || !latest.current.runtime.isActive()) return false;
    try {
      if (budget.current?.source !== state) budget.current = { source: state, captured: captureConversationWorkspace(state) };
      const others = [...controllers.current.values()].map((controller) => controller.currentRun)
        .filter((run) => run.runId !== record.runId);
      return canAdmitConversationRun(budget.current.captured, record, others);
    } catch { return false; }
  }

  async function checkpoint(record: Readonly<ConversationRun>): Promise<RunCheckpointResult> {
    const access = latest.current;
    const current = access.current();
    if (!mounted.current || !access.runtime.isActive() || !current) return { kind: 'blocked' };
    let next: DeskState;
    try {
      const previous = current.conversationRuns?.find((saved) => saved.runId === record.runId);
      next = previous
        ? saveConversationRunCheckpoint(current, record, previous.lastSequence)
        : prepareConversationRun(current, record, record.inputChunks.join(''));
    } catch {
      access.error('The response could not be recorded within this workspace. Existing work was kept; no replacement was sent.');
      return { kind: 'not-saved' };
    }
    access.present(next);
    // Keep the observed prefix even while an earlier write blocks the queue.
    // This is known not attempted, never an ambiguous storage outcome.
    if (access.blocked()) return { kind: 'blocked' };
    const result = await access.save(next);
    if (!mounted.current || !access.runtime.isActive()) return { kind: 'unknown' };
    if (result.kind === 'saved') {
      const saved = result.state.conversationRuns?.find((item) => item.runId === record.runId);
      return saved ? { kind: 'saved', record: saved } : { kind: 'unknown' };
    }
    if (result.kind === 'blocked') return { kind: 'blocked' };
    return result.kind === 'failed' || result.kind === 'conflict' ? { kind: 'not-saved' } : { kind: 'unknown' };
  }

  function attach(run: ConversationRun, mode: 'new' | 'restored') {
    const { runtime } = latest.current;
    const port = mode === 'restored' ? runtime.participantForRun?.(run.participant) ?? runtime.participant : sendPort(run.participant);
    if (!port || !runtime.isActive() || controllers.current.has(run.runId)) return null;
    const controller = new ConversationRunController({ run, mode, port,
      checkpoint, acceptRun: admitted,
      // Native Start validates its own fresh pin/availability reply. A later
      // picker refresh affects display, not that request's authority. The
      // workspace and cross-run barriers still apply at the dispatch instant.
      canDispatch: () => !latest.current.blocked() && !otherUnconfirmed(run.runId)
        && (!!runtime.participantForRun || !catalogBlock(run.participant)),
    });
    if (!controller.snapshot.available) {
      controller.dispose();
      return null;
    }
    controllers.current.set(run.runId, controller);
    controller.subscribe(refresh);
    return controller;
  }

  useEffect(() => {
    mounted.current = true;
    const clear = () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.dispose();
      controllers.current.clear(); restoreAttempts.current.clear(); localClosures.current.clear(); checkingSends.current.clear(); budget.current = null;
    };
    const detach = options.runtime.subscribeInvalidation(clear);
    const detachParticipants = options.runtime.subscribeParticipants?.(refresh);
    return () => { detachParticipants?.(); detach(); clear(); };
  }, [options.runtime]);

  useEffect(() => {
    const runtime = options.runtime;
    if (!runtime.refreshParticipants) return;
    let queued = false;
    let active = true;
    const refreshVisible = () => {
      if (!active || queued || document.visibilityState !== 'visible') return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active && runtime.isActive() && document.visibilityState === 'visible') void refreshAvailability(runtime);
      });
    };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      active = false;
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [options.runtime]);

  useLayoutEffect(() => {
    if (!options.runtime.participant && !options.runtime.participantForRun) return;
    for (const run of options.state?.conversationRuns ?? []) {
      const needsCleanupCheck = incompleteStop(run) || (!!options.runtime.participant?.status || !!options.runtime.participantForRun) && hasRecordedTerminal(run);
      if ((isConversationRunClosed(run) && !needsCleanupCheck) || controllers.current.has(run.runId) || restoreAttempts.current.has(run.runId)) continue;
      restoreAttempts.current.add(run.runId);
      try { attach(run, 'restored'); }
      catch { /* Another participant's record remains readable without attaching to the wrong host. */ }
    }
  }, [options.state, options.runtime]);

  function confirmSaved(state: DeskState) {
    if (options.runtime.participantChoices !== undefined) refresh();
    for (const run of state.conversationRuns ?? []) {
      controllers.current.get(run.runId)?.confirmCheckpoint(run);
      const pending = localClosures.current.get(run.runId);
      if (pending && JSON.stringify(pending.run) === JSON.stringify(run)) {
        localClosures.current.delete(run.runId);
        refresh();
      }
    }
  }

  function otherUnconfirmed(except?: string) {
    if ([...localClosures.current.keys()].some((id) => id !== except)) return true;
    // Do not read snapshot here: its canStart field invokes canDispatch and
    // would recurse through every other controller's admission check.
    return [...controllers.current.values()].some((controller) =>
      controller.currentRun.runId !== except && controller.startBarrier);
  }
  function busy(sessionId: string, ownAvailabilityCheck = false) {
    if (!ownAvailabilityCheck && checkingSends.current.has(sessionId)) return true;
    if (cleanupPending() || otherUnconfirmed()) return true;
    if (latest.current.current()?.conversationRuns?.some((run) => run.sessionId === sessionId && !isConversationRunClosed(run))) return true;
    if ([...localClosures.current.values()].some((entry) => entry.run.sessionId === sessionId)) return true;
    for (const controller of controllers.current.values()) {
      const snapshot = controller.snapshot;
      if (snapshot.run.sessionId === sessionId && (!isConversationRunClosed(snapshot.run) || snapshot.checkpointState !== 'saved')) return true;
    }
    return false;
  }
  function cleanupPending() {
    if ([...controllers.current.values()].some((controller) => controller.snapshot.cleanupPending)) return true;
    if ([...localClosures.current.values()].some((entry) => !!entry.run.cleanupAcknowledgment)) return true;
    return latest.current.current()?.conversationRuns?.some((run) => incompleteStop(run) && !run.cleanupAcknowledgment && !controllers.current.has(run.runId)) ?? false;
  }
  function matchingParticipant(run: Readonly<ConversationRun>) {
    if (latest.current.runtime.participantForRun) return true;
    const connected = latest.current.runtime.participant?.identity;
    return !!connected && connected.id === run.participant.id && connected.label === run.participant.label
      && connected.executionHost === run.participant.executionHost && connected.model === run.participant.model;
  }
  function retryConnection(run: ConversationRun) {
    if (!matchingParticipant(run)) return;
    try {
      const restored = attach(run, 'restored');
      if (restored) void restored.reconcile();
      else latest.current.error('This participant connection is still unavailable. No message was resent.');
    } catch { latest.current.error('The connected participant does not match this saved run. No message was resent.'); }
  }
  function runRecords() {
    const records = new Map((latest.current.current()?.conversationRuns ?? []).map((run) => [run.runId, run]));
    for (const [id, controller] of controllers.current) records.set(id, controller.currentRun);
    for (const [id, entry] of localClosures.current) records.set(id, entry.run);
    return records;
  }
  function needsCleanup(run: ConversationRun) {
    return controllers.current.get(run.runId)?.snapshot.cleanupPending
      ?? (incompleteStop(run) && (!run.cleanupAcknowledgment || localClosures.current.has(run.runId)));
  }
  function statusText(run: ConversationRun) {
    const snapshot = controllers.current.get(run.runId)?.snapshot;
    if (snapshot?.stopState === 'pending') return 'Stop requested';
    if (needsCleanup(run)) return 'Local cleanup unconfirmed';
    if (run.cleanupAcknowledgment) return 'Cleanup left unconfirmed by your choice';
    if (run.closure?.kind === 'unknown') return 'Closed with outcome unknown';
    if (run.closure?.kind === 'interrupted') return 'Response interrupted; recorded prefix retained';
    if (run.phase === 'completed') return 'Response completed';
    if (run.phase === 'stopped') return 'Response stopped';
    if (run.phase === 'failed') return 'Response failed';
    if (snapshot?.canStart || run.phase === 'prepared' && snapshot?.status === 'idle') return 'Prepared · not started';
    if (snapshot?.stopState === 'unknown') return 'Stop unconfirmed';
    if (snapshot?.startRefusal?.reason === 'run-not-prepared') return 'Stopped before it started';
    if (run.phase === 'prepared') return 'Prepared · start not confirmed';
    return 'Response unfinished';
  }
  function focusGlobalStatus(run: ConversationRun, title: string) {
    globalAction.current = { runId: run.runId, title, label: run.participant.label };
    setGlobalAnnouncement(`${title} · ${run.participant.label}: ${statusText(run)}.`);
    globalStatus.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    const target = globalAction.current;
    if (!target) return;
    const run = runRecords().get(target.runId);
    if (run) setGlobalAnnouncement(`${target.title} · ${target.label}: ${statusText(run)}.`);
  });

  function canSaveEdits(next: DeskState, previousView?: DeskState) {
    const records = new Map([...controllers.current.values()].map((controller) => [controller.currentRun.runId, controller.currentRun]));
    for (const [id, entry] of localClosures.current) records.set(id, entry.run);
    return canSaveConversationWorkspaceWithRuns(next, [...records.values()], previousView);
  }

  /** The port a new run uses: a local model's own exact pin, never the Claude entry in its place. */
  function sendPort(identity: Readonly<ParticipantIdentity>) {
    const { runtime } = latest.current;
    return isLocalParticipant(identity) ? runtime.participantForRun?.(identity) : runtime.participant;
  }
  // Catalog entries are supplied by the integration, never authorized by a saved preference.
  // Recovery controllers keep the original port/identity; choosing the next reply cannot retarget Stop.
  function catalogBlock(identity: Readonly<ParticipantIdentity>) {
    const { runtime } = latest.current;
    if (runtime.participantAvailabilityMessage) return runtime.participantAvailabilityMessage;
    if (runtime.participantChoices === undefined) return undefined;
    const choice = runtime.participantChoices.find((item) => sameParticipantIdentity(item.identity, identity));
    if (isLocalParticipant(identity)) {
      // Section 20.2: the page derives "missing" and "changed" from a ready route.
      const problem = runtime.localCatalog ? localChoiceProblem(identity, runtime.localCatalog) : null;
      if (problem) return problem;
      if (!choice?.approved || !choice.available) return choice?.unavailableReason ?? 'This local model is unavailable right now.';
      if (!runtime.participantForRun) return 'This Mac app has no local model connection. No other model will be used.';
      return undefined;
    }
    if (!choice?.approved) return 'This saved participant is no longer an approved choice. Choose an approved participant; nothing was substituted.';
    if (!choice.available) return choice.unavailableReason ?? 'This participant is unavailable.';
    if (!runtime.participant || !sameParticipantIdentity(runtime.participant.identity, identity)) return 'This participant has no matching connection. No other model will be used.';
    return undefined;
  }
  function choiceBlock(sessionId: string) {
    const access = latest.current;
    const session = access.current()?.sessions.find((item) => item.id === sessionId);
    const choice = session?.participantChoice;
    if (access.runtime.participantAvailabilityMessage) return access.runtime.participantAvailabilityMessage;
    if (access.runtime.participantChoices === undefined && !choice) return undefined;
    if (!choice) return 'Choose a participant for this session before sending.';
    if (access.runtime.participantChoices === undefined) return 'The saved participant is unavailable in this workspace. No other model will be used.';
    const blocked = catalogBlock(choice);
    if (blocked) return blocked;
    const savedChoice = access.saved()?.sessions.find((item) => item.id === sessionId)?.participantChoice;
    if (!savedChoice || !sameParticipantIdentity(savedChoice, choice)) return 'The participant choice is not yet confirmed saved. Your draft is retained.';
    return undefined;
  }

  async function refreshAvailability(runtime = latest.current.runtime): Promise<boolean> {
    try { await runtime.refreshParticipants?.(); return true; }
    catch {
      if (mounted.current && runtime.isActive() && runtime === latest.current.runtime) {
        latest.current.error('Participant availability could not be checked. Your saved work and draft are kept; try checking again.');
      }
      return false;
    }
  }

  async function startPrepared(controller: ConversationRunController) {
    const runtime = latest.current.runtime;
    try { await controller.start(); }
    catch {
      if (mounted.current && runtime.isActive() && runtime === latest.current.runtime) {
        latest.current.error('The participant action could not be confirmed. Check the prepared response before trying again.');
      }
    } finally {
      // Starting can consume the last confirmed trial run or reveal a changed
      // installation/login. Update display state without reopening the picker.
      if (mounted.current && runtime.isActive()) await refreshAvailability(runtime);
    }
  }

  async function send(sessionId: string) {
    const initial = latest.current;
    const original = initial.current();
    const input = original?.drafts[sessionId];
    const selected = original?.sessions.find((item) => item.id === sessionId)?.participantChoice;
    if (!mounted.current || !initial.runtime.isActive() || !original || initial.blocked() || busy(sessionId) || !input?.trim()) return;
    checkingSends.current.add(sessionId);
    refresh();
    try {
      // Availability is checked before creating IDs, clearing a draft or saving
      // any prepared run. A stale display cache never turns a draft into a run.
      if (!await refreshAvailability(initial.runtime)) return;
      const access = latest.current;
      const state = access.current();
      const choice = state?.sessions.find((item) => item.id === sessionId)?.participantChoice;
      const participant = choice ? sendPort(choice) : access.runtime.participant;
      const local = isLocalParticipant(participant?.identity);
      if (!mounted.current || access.runtime !== initial.runtime || !access.runtime.isActive() || !state || !participant
        || access.blocked() || busy(sessionId, true) || choiceBlock(sessionId)
        || state.selection.sessionId !== sessionId || state.drafts[sessionId] !== input
        || (!!selected !== !!choice) || selected && choice && !sameParticipantIdentity(selected, choice)) return;
      if (!local && access.runtime.participantInputLimit !== undefined && new TextEncoder().encode(input).byteLength > access.runtime.participantInputLimit) {
        access.error('This message is too long for the current trial. Shorten it before sending. Your full draft is kept; nothing was sent.');
        return;
      }
      let run: ConversationRun;
      try {
        const id = access.runtime.createId ?? (() => crypto.randomUUID());
        // Section 20.3: a local model is sent this session's earlier completed
        // turns by run id, oldest whole turns left out to fit one limit.
        const context = local ? selectLocalContext(state.conversationRuns ?? [], sessionId, input) : undefined;
        if (context?.kind === 'too-large') {
          access.error('This message is too long for a local model. Shorten it before sending. Your full draft is kept; nothing was sent.');
          return;
        }
        const result = createConversationRun({ runId: id(), sessionId, userMessageId: id(), assistantMessageId: id(),
          participant: { ...participant.identity }, input, createdAt: logicalTime(state, undefined, sessionId),
          ...(context?.kind === 'ok' ? { contextRunIds: context.contextRunIds } : {}) });
        if (result.kind !== 'ok') {
          access.error('This message could not be prepared within the current participant limits. Your draft is unchanged.');
          return;
        }
        if (!admitted(result.run)) {
          access.error('This message could not be prepared within this workspace’s current limits. Your draft and previous replies are unchanged; no message was sent.');
          return;
        }
        prepareConversationRun(state, result.run, input);
        run = result.run;
      } catch {
        access.error('The local message record could not be prepared. Your draft is unchanged; no message was sent.');
        return;
      }
      try {
        const controller = attach(run, 'new');
        if (!controller) {
          access.error('The participant connection could not be opened. Your draft is unchanged; try sending again after the connection is available.');
          return;
        }
        access.error('');
        void startPrepared(controller);
      } catch {
        access.error('The participant connection could not be opened. Your draft is unchanged; no message was sent.');
      }
    } finally {
      checkingSends.current.delete(sessionId);
      refresh();
    }
  }

  async function closeUnknown(run: ConversationRun) {
    const access = latest.current;
    const state = access.current();
    if (!state || !access.runtime.isActive() || isConversationRunClosed(run)) return;
    const controller = controllers.current.get(run.runId);
    if (controller) { controller.closeAsUnknown(); return; }
    const closed = closeConversationRun(run, { kind: 'unknown', reason: 'user-closed', at: logicalTime(state, run) });
    if (closed.kind !== 'ok') { access.error('This run could not be closed locally. Its saved prefix is unchanged.'); return; }
    await saveLocalClosure(run, closed.run);
  }

  async function acknowledgeCleanup(run: ConversationRun) {
    const access = latest.current;
    const state = access.current();
    if (!state || !access.runtime.isActive() || access.blocked() || !isConversationRunClosed(run)) return;
    const controller = controllers.current.get(run.runId);
    if (controller) { controller.acknowledgeUnreachableCleanup(); return; }
    if (!incompleteStop(run) || run.cleanupAcknowledgment || localClosures.current.has(run.runId)) return;
    const acknowledged = acknowledgeUnreachableCleanup(run, logicalTime(state, run));
    if (acknowledged.kind !== 'ok') { access.error('The cleanup acknowledgment could not be saved. The original response is unchanged.'); return; }
    if (!admitted(acknowledged.run)) { access.error(errors['recovery-size-limit']!); return; }
    await saveLocalClosure(run, acknowledged.run);
  }

  async function saveLocalClosure(run: ConversationRun, next: ConversationRun) {
    if (localClosures.current.has(run.runId)) return;
    const access = latest.current;
    const pending: LocalClosure = { run: next, saved: run, saving: true };
    localClosures.current.set(run.runId, pending); refresh();
    const result = await checkpoint(next);
    if (!mounted.current || !access.runtime.isActive() || localClosures.current.get(run.runId) !== pending) return;
    pending.saving = false;
    if (result.kind === 'saved' && JSON.stringify(result.record) === JSON.stringify(next)) localClosures.current.delete(run.runId);
    else pending.error = result.kind === 'blocked'
      ? 'This local recovery choice has not been saved. Resolve the earlier workspace save.'
      : 'This local recovery choice is not yet confirmed saved. The retained response text is unchanged.';
    refresh();
  }

  /** Retry (section 20.4): only the owner's explicit Send makes a new run with new ids. */
  function retry(run: ConversationRun) {
    const access = latest.current;
    const state = access.current();
    if (!state || !access.runtime.isActive() || !access.restoreDraft || !canRetryLocalRun(run)) return;
    if ((state.drafts[run.sessionId] ?? '') !== '') {
      access.error('Retry needs an empty message box so nothing you typed is replaced. Clear or send your draft first.');
      return;
    }
    access.error('');
    access.restoreDraft(run.sessionId, run.inputChunks.join(''));
  }

  const selected = options.state?.selection.sessionId;
  const selectedRuns = new Map((options.state?.conversationRuns ?? []).filter((run) => run.sessionId === selected)
    .map((run) => [run.runId, run]));
  for (const [id, controller] of controllers.current) {
    if (controller.currentRun.sessionId === selected) selectedRuns.set(id, controller.currentRun);
  }
  for (const [id, entry] of localClosures.current) if (entry.run.sessionId === selected) selectedRuns.set(id, entry.run);
  const lastSelectedRunId = [...selectedRuns.keys()].at(-1);
  const content = selectedRuns.size ? <>{[...selectedRuns.values()].map((run) => {
    const controller = controllers.current.get(run.runId);
    const snapshot = controller?.snapshot;
    const local = localClosures.current.get(run.runId);
    const stopped = snapshot?.stopState;
    const closed = isConversationRunClosed(run);
    const cleanupState = snapshot?.cleanupState ?? (incompleteStop(run) ? 'unknown' : 'none');
    const connected = options.runtime.participant?.identity;
    const matches = matchingParticipant(run);
    const uncertain = !closed && (!snapshot || ['unknown', 'unavailable'].includes(snapshot.status));
    const obsoleteActionError = closed && snapshot?.error && ['stop-unknown', 'start-unknown', 'start-refused', 'reconcile-unknown', 'subscription-failed'].includes(snapshot.error);
    const localRefusal = snapshot?.startRefusal && isLocalParticipant(run.participant) && !closed
      ? localStartRefusalMessage(snapshot.startRefusal.reason, snapshot.startRefusal.retryable, run.participant) : undefined;
    const startMessage = localRefusal ?? (snapshot?.startRefusal?.reason === 'run-not-prepared' ? 'Stopped before it started. Check this run to read its recorded ending.'
      : snapshot?.startRefusal && !snapshot.startRefusal.retryable ? 'This prepared message cannot be started. Its text is kept; check the run or close it locally before preparing another message.' : undefined);
    const oldPinMessage = !closed && !isLocalParticipant(run.participant) && options.runtime.participantForRun && connected && !sameParticipantIdentity(connected, run.participant)
      ? 'This saved run was prepared for a different participant version. Its text is kept and Start is unavailable; you can still check its status or request Stop.' : undefined;
    const message = local?.error ?? startMessage ?? (!obsoleteActionError && snapshot?.error ? errors[snapshot.error] : undefined) ?? oldPinMessage ?? (uncertain
      ? controller ? 'This run is not confirmed. Check its status or request Stop. A local closure preserves the recorded prefix without confirming completion.'
        : connected && !matches
          ? `This saved run belongs to ${run.participant.label} using ${run.participant.model} on ${run.participant.executionHost}. The connected participant has a different identity or model. Its saved prefix remains readable; reconnect its original participant or close the run as unknown.`
          : 'This participant is unavailable. The saved prefix is readable; you can close this run as unknown without claiming it stopped.' : undefined);
    const canClose = !closed && !local && (snapshot ? snapshot.canCloseAsUnknown : !controller);
    const interruptedClose = snapshot?.pendingEvents.some((event) => event.type === 'stopped') ?? false;
    const canAcknowledge = !local && (snapshot?.canAcknowledgeUnreachableCleanup ?? (closed && incompleteStop(run) && !run.cleanupAcknowledgment));
    const checkpointPending = snapshot ? snapshot.checkpointState !== 'saved' : !!local;
    return <div key={run.runId} data-run-controls data-preview-refresh-hold={!closed || checkpointPending || snapshot?.cleanupPending ? '' : undefined}>
      <RunTranscript run={run} savedSequence={snapshot ? snapshot.persistedSequence : (local?.saved ?? run).lastSequence}
        savedOutput={snapshot ? snapshot.persistedPrefix : (local?.saved ?? run).outputChunks.join('')}
        stopState={stopped === 'pending' ? 'requesting' : stopped ?? (run.phase === 'stopped' ? 'confirmed' : 'idle')}
        runtimeStatus={snapshot?.status ?? (!closed ? connected && !matches ? 'mismatched' : 'unavailable' : undefined)}
        canStop={snapshot?.canStop ?? false}
        cleanupState={cleanupState}
        checkpointPending={checkpointPending} saving={snapshot?.saving ?? local?.saving ?? false}
        error={message} onStop={() => void controller?.stop()} />
      {controller && snapshot?.canStart && <button type="button" className="recovery-button" disabled={options.blocked() || cleanupPending() || otherUnconfirmed(run.runId) || !!catalogBlock(run.participant)}
        onClick={(event) => { if (!latest.current.blocked() && !cleanupPending() && !otherUnconfirmed(run.runId) && !catalogBlock(run.participant)) { focusStatus(event.currentTarget); void startPrepared(controller); } }}>Start prepared message</button>}
      {controller && snapshot?.canCheckStatus && <button type="button" className="recovery-button secondary"
        onClick={(event) => { focusStatus(event.currentTarget); void controller.reconcile(); }}>Check run status</button>}
      {!controller && (!closed || incompleteStop(run)) && matches && <button type="button" className="recovery-button secondary"
        onClick={(event) => { focusStatus(event.currentTarget); retryConnection(run); }}>Retry participant connection</button>}
      {canAcknowledge && <><p className="run-recovery-note">Cleanup cannot be confirmed with the original participant. You can keep this response and continue after saving that choice. This does not stop a process or confirm cleanup; it may still be running.</p>
        <button type="button" className="recovery-button secondary" disabled={options.blocked()} onClick={(event) => {
          focusStatus(event.currentTarget); void acknowledgeCleanup(run);
        }}>Leave cleanup unconfirmed</button></>}
      {canClose && <><p className="run-recovery-note">{interruptedClose
        ? 'This keeps the accepted response prefix and recorded ending. Text after a missing update is not included; cleanup is tracked separately.'
        : 'Close as unknown keeps the recorded prefix and allows another message after saving. It does not stop a participant or confirm completion.'}</p>
        <button type="button" className="recovery-button secondary"
          onClick={(event) => { focusStatus(event.currentTarget); void closeUnknown(run); }}>{interruptedClose ? 'Close interrupted reply' : 'Close as unknown'}</button></>}
      {run.runId === lastSelectedRunId && canRetryLocalRun(run) && !local && checkpointPending === false && options.restoreDraft && <>
        <p className="run-recovery-note">Retry puts your message back in the box below. Nothing is sent until you press Send; this reply stays as it is.</p>
        <button type="button" className="recovery-button secondary" onClick={() => retry(run)}>Retry</button></>}
    </div>;
  })}</> : undefined;
  const visibleSession = options.state?.selection.route === 'sessions'
    && (options.state.preferences.nexusView ?? 'navigator') === 'navigator' ? selected : null;
  const allRuns = [...runRecords().values()];
  const otherRuns = allRuns.filter((run) => run.sessionId !== visibleSession
    && (!isConversationRunClosed(run) || needsCleanup(run) || localClosures.current.has(run.runId)));
  // These controls include saved records without a controller. Reaching recovery
  // must not depend on changing views, saving, or reconnecting the wrong model.
  const otherRunControls = <>
    <p ref={globalStatus} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" data-global-run-status
      className={globalAnnouncement ? 'run-recovery-note' : 'sr-only'}>{globalAnnouncement}</p>
    {otherRuns.length > 0 && <section className="other-run-controls" aria-label="Other active responses">
      <ul>{otherRuns.map((run) => {
        const controller = controllers.current.get(run.runId);
        const snapshot = controller?.snapshot;
        const local = localClosures.current.get(run.runId);
        const title = options.state?.sessions.find((session) => session.id === run.sessionId)?.title ?? 'Saved session';
        const closed = isConversationRunClosed(run);
        const canClose = !closed && !local && (snapshot ? snapshot.canCloseAsUnknown : !controller);
        const interruptedClose = snapshot?.pendingEvents.some((event) => event.type === 'stopped') ?? false;
        const canAcknowledge = !local && (snapshot?.canAcknowledgeUnreachableCleanup ?? (closed && incompleteStop(run) && !run.cleanupAcknowledgment));
        return <li key={run.runId} data-other-run-id={run.runId}>
          <span>{title} · {run.participant.label} · Run {run.runId}</span>
          <span data-other-run-status>{statusText(run)}</span>
          {controller && <button type="button" className="recovery-button secondary" disabled={!snapshot?.canStop}
            aria-label={`Stop response in ${title}`} onClick={() => {
              focusGlobalStatus(run, title); void controller.stop();
            }}>Stop</button>}
          {controller && snapshot?.canCheckStatus && <button type="button" className="recovery-button secondary"
            aria-label={`Check response in ${title}`} onClick={() => { focusGlobalStatus(run, title); void controller.reconcile(); }}>Check</button>}
          {controller && snapshot?.canStart && <button type="button" className="recovery-button secondary"
            disabled={options.blocked() || cleanupPending() || otherUnconfirmed(run.runId) || !!catalogBlock(run.participant)} aria-label={`Start prepared message in ${title}`}
            onClick={() => { if (!latest.current.blocked() && !cleanupPending() && !otherUnconfirmed(run.runId) && !catalogBlock(run.participant)) { focusGlobalStatus(run, title); void startPrepared(controller); } }}>Start prepared message</button>}
          {!controller && matchingParticipant(run) && <button type="button" className="recovery-button secondary"
            aria-label={`Retry participant connection in ${title}`} onClick={() => { focusGlobalStatus(run, title); retryConnection(run); }}>Retry connection</button>}
          {!controller && !matchingParticipant(run) && <span>Reconnect {run.participant.label} using {run.participant.model} on {run.participant.executionHost} to check or stop this run.</span>}
          {canClose && <><span>{interruptedClose
            ? 'This keeps the accepted response prefix and recorded ending. Text after a missing update is not included; cleanup is tracked separately.'
            : 'Close locally without confirming Stop; the participant may still be running.'}</span>
            <button type="button" className="recovery-button secondary" aria-label={`${interruptedClose ? 'Close interrupted reply' : 'Close response as unknown'} in ${title}`}
              onClick={() => { focusGlobalStatus(run, title); void closeUnknown(run); }}>{interruptedClose ? 'Close interrupted reply' : 'Close as unknown'}</button></>}
          {canAcknowledge && <><span>Cleanup cannot be confirmed. Keeping the response and continuing does not stop a process; it may still be running.</span>
            <button type="button" className="recovery-button secondary" disabled={options.blocked()} aria-label={`Leave cleanup unconfirmed in ${title}`}
              onClick={() => { focusGlobalStatus(run, title); void acknowledgeCleanup(run); }}>Leave cleanup unconfirmed</button></>}
          {local?.error && <span role="alert">{local.error}</span>}
          {snapshot?.error === 'recovery-size-limit' && <span role="alert">{errors[snapshot.error]}</span>}
          {snapshot?.error === 'reconcile-unknown' && <span role="status">{errors[snapshot.error]}</span>}
        </li>;
      })}</ul>
    </section>}
  </>;
  const cleanupRun = allRuns.find(needsCleanup);
  const cleanupTitle = cleanupRun && (options.state?.sessions.find((session) => session.id === cleanupRun.sessionId)?.title ?? 'Saved session');
  const selectedSession = options.state?.sessions.find((session) => session.id === selected);
  const selectionBlock = selected ? choiceBlock(selected) : undefined;
  const inputLimit = options.runtime.participantInputLimit;
  const selectedLocal = isLocalParticipant(selectedSession?.participantChoice);
  const inputTooLarge = !selectedLocal && inputLimit !== undefined && new TextEncoder().encode(options.state?.drafts[selected ?? ''] ?? '').byteLength > inputLimit;
  const inputBlock = inputTooLarge ? 'This message is too long for the current trial. Shorten it before sending. Your full draft is kept.' : undefined;
  const savedSelection = selectedSession?.participantChoice;
  const choiceLabel = savedSelection
    ? `${selectedLocal ? ollamaChoiceTitle(savedSelection, options.runtime.localCatalog) : savedSelection.label}${options.runtime.participantAvailabilityChecking ? ' · Checking availability' : options.runtime.participantChoices === undefined || catalogBlock(savedSelection) ? ' · Unavailable' : options.runtime.refreshParticipants ? ' · Available' : ''}`
    : options.runtime.participantChoices !== undefined ? 'No participant chosen' : options.runtime.participant?.identity.label;
  const participantMode = options.runtime.participantChoices !== undefined || !!selectedSession?.participantChoice
    || !!options.runtime.participant || options.state?.schemaVersion === 2;
  const hasUnconfirmed = () => cleanupPending() || localClosures.current.size > 0
    || [...runRecords().values()].some((run) => !isConversationRunClosed(run)) || [...controllers.current.values()].some((controller) => {
    const snapshot = controller.snapshot;
    return !isConversationRunClosed(snapshot.run) || snapshot.checkpointState !== 'saved' || snapshot.cleanupPending;
  });
  return { send, refreshAvailability, confirmSaved, content, otherRunControls, hasUnconfirmed, canSaveEdits,
    participantLabel: participantMode ? choiceLabel ?? 'Participant unavailable' : undefined,
    selectedLocalProblem: selectedLocal && savedSelection && !options.runtime.participantAvailabilityChecking ? catalogBlock(savedSelection) : undefined,
    busy: selected ? busy(selected) : false,
    unavailable: participantMode && (!(selectedLocal ? options.runtime.participantForRun : options.runtime.participant) || options.blocked() || cleanupPending() || !!selectionBlock || inputTooLarge),
    sendBlockedReason: participantMode && options.blocked()
      ? 'Sending is paused until the workspace save is resolved. Your draft is retained.'
      : selectionBlock ? selectionBlock
      : participantMode && !(selectedLocal ? options.runtime.participantForRun : options.runtime.participant) ? 'Connect a participant before sending. Your draft remains editable.'
      : participantMode && cleanupPending() ? `Cleanup for ${cleanupTitle ?? 'a saved session'}${cleanupRun ? ` (run ${cleanupRun.runId})` : ''} is not confirmed. Use the available recovery controls for that response before sending another message.` : inputBlock,
  };
}
