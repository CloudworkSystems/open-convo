import { useId, useRef } from 'react';
import type { ConversationRun, ConversationRunPhase, ParticipantStopReason } from '../domain/conversation-run-types';
import type { ConversationRunStatus, ParticipantCleanupState } from '../adapters/participant-runtime';
import { isConversationRunClosed } from '../domain/conversation-runs';
import './run-transcript.css';

export type RunStopState = 'idle' | 'requesting' | 'unknown' | 'confirmed';
type TranscriptRuntimeStatus = ConversationRunStatus | 'mismatched';

export interface RunTranscriptProps {
  run: ConversationRun;
  savedSequence: number | null;
  /** Exact response prefix from the persisted run, never inferred from event sequence. */
  savedOutput?: string;
  stopState: RunStopState;
  canStop?: boolean;
  cleanupState?: ParticipantCleanupState;
  runtimeStatus?: TranscriptRuntimeStatus;
  checkpointPending?: boolean;
  saving: boolean;
  error?: string;
  onStop: () => void;
}

const phaseLabels: Record<ConversationRunPhase, string> = {
  prepared: 'Preparing response',
  running: 'Response in progress',
  completed: 'Response complete',
  stopped: 'Response stopped',
  failed: 'Response failed',
  unknown: 'Run status unknown',
};

const runtimeLabels: Record<TranscriptRuntimeStatus, string> = {
  idle: 'Prepared · not started',
  preparing: 'Preparing response',
  starting: 'Starting response',
  running: 'Response in progress',
  stopping: 'Stop requested · awaiting confirmation',
  unknown: 'Run status unknown',
  terminal: 'Run ended · outcome unconfirmed',
  disposed: 'Run connection unavailable · outcome unconfirmed',
  unavailable: 'Participant connection unavailable',
  mismatched: 'Saved run belongs to a different participant or model',
};

function terminalLabel(phase: 'stopped' | 'failed', reason: ParticipantStopReason | undefined, host: string) {
  const result = phase === 'stopped' ? 'Response stopped' : 'Response failed';
  if (reason === 'local-stop') return `${phase === 'stopped' ? 'Stopped' : 'Local stop reported'} on ${host} · provider cancellation unconfirmed`;
  if (reason === 'stop-incomplete') return 'Stop incomplete · participant termination unconfirmed';
  const reasons = { 'reply-too-long': 'reply length limit reached', 'paid-overflow': 'paid usage could not be ruled out; check your provider usage',
    timeout: 'time limit reached', 'process-error': 'participant process error' };
  return reason ? `${result} · ${reasons[reason]}`
    : phase === 'stopped' ? `${result} · provider cancellation unconfirmed` : result;
}

/** Presentation only: provider text stays literal and save failure never prevents Stop. */
export function RunTranscript({ run, savedSequence, savedOutput, stopState, canStop = true, cleanupState = 'none', runtimeStatus, checkpointPending = false, saving, error, onStop }: RunTranscriptProps) {
  const statusId = useId();
  const pendingLabelId = useId();
  const statusTarget = useRef<HTMLParagraphElement>(null);
  const output = run.outputChunks.join('');
  const terminal = run.phase === 'completed' || run.phase === 'stopped' || run.phase === 'failed';
  const closed = isConversationRunClosed(run);
  const cleanupPending = cleanupState === 'unknown' || cleanupState === 'owned';
  const stopDisabled = !canStop || (!cleanupPending && (terminal || closed || stopState === 'confirmed')) || stopState === 'requesting';
  const phase = run.closure?.kind === 'unknown' ? 'Closed with outcome unknown'
    : run.closure?.kind === 'interrupted' ? 'Run ended with incomplete response'
    : terminal ? run.phase === 'stopped' || run.phase === 'failed' ? terminalLabel(run.phase, run.reason, run.participant.executionHost) : phaseLabels[run.phase]
    : stopState === 'confirmed' ? 'Response stopped · provider cancellation unconfirmed'
    : runtimeStatus === 'unknown' || runtimeStatus === 'disposed' || runtimeStatus === 'unavailable' || runtimeStatus === 'mismatched' ? runtimeLabels[runtimeStatus]
    : stopState === 'requesting' ? 'Stop requested · awaiting confirmation'
    : stopState === 'unknown' ? 'Stop outcome unknown'
    : runtimeStatus ? runtimeLabels[runtimeStatus]
    : phaseLabels[run.phase];
  const stopIncomplete = run.reason === 'stop-incomplete'
    || run.closure?.kind === 'interrupted' && 'reason' in run.closure.terminalEvent && run.closure.terminalEvent.reason === 'stop-incomplete';
  const stopLabel = stopState === 'requesting' ? 'Stopping…'
    : cleanupState === 'unowned' ? 'Cleanup unconfirmed'
    : cleanupPending ? 'Retry Stop' : cleanupState === 'cleared' && stopIncomplete ? 'Cleanup confirmed'
    : stopIncomplete ? 'Stop unconfirmed'
    : stopState === 'unknown' ? 'Retry Stop'
    : stopState === 'confirmed' ? 'Stopped' : 'Stop';
  const sequenceConfirmed = savedSequence !== null && Number.isSafeInteger(savedSequence)
    && savedSequence >= 0 && savedSequence <= run.lastSequence;
  const prefixMatches = savedOutput !== undefined && output.startsWith(savedOutput);
  const prefixMismatch = savedOutput !== undefined && !prefixMatches;
  const pendingOutput = prefixMatches ? output.slice(savedOutput!.length) : undefined;
  const pending = checkpointPending || !sequenceConfirmed || savedSequence !== run.lastSequence || Boolean(pendingOutput);
  const pendingLabel = checkpointPending && savedSequence === run.lastSequence && !pendingOutput
    ? 'Run status changes are not yet saved.' : 'Newer updates are not yet saved.';
  const saveLabel = prefixMismatch ? 'Save status could not be verified for this response.'
    : !sequenceConfirmed ? 'Save not yet confirmed.'
    : `Saved through update ${savedSequence}.${pending ? ` ${pendingLabel}` : ''}`;
  const emptyOutput = closed || run.phase === 'unknown' || runtimeStatus === 'unknown' || runtimeStatus === 'disposed' || runtimeStatus === 'unavailable' || runtimeStatus === 'mismatched'
    ? 'No response text is available.' : terminal ? 'No response text was received.' : 'Waiting for response text.';

  return (
    <section className="run-transcript" aria-label="Run transcript" data-run-id={run.runId} data-session-id={run.sessionId}>
      <header className="run-transcript-heading">
        <p id={statusId} ref={statusTarget} tabIndex={-1} data-run-status="true" className="run-phase" role="status" aria-live="polite" aria-atomic="true">{phase}</p>
        <button type="button" className="run-stop" disabled={stopDisabled} onClick={() => {
          statusTarget.current?.focus({ preventScroll: true });
          statusTarget.current?.scrollIntoView({ block: 'nearest' });
          onStop();
        }} aria-describedby={statusId}>
          {stopLabel}
        </button>
      </header>
      {run.closure?.kind === 'interrupted' && (run.closure.terminalEvent.type === 'stopped' || run.closure.terminalEvent.type === 'failed')
        && <p className="run-empty">{terminalLabel(run.closure.terminalEvent.type, run.closure.terminalEvent.reason, run.participant.executionHost)}</p>}
      {run.closure?.kind === 'interrupted' && <p className="run-empty" data-interruption-reason>
        {run.closure.reason === 'workspace-limit'
          ? 'This workspace reached its storage limit. The retained response is incomplete.'
          : 'Some response updates could not be verified. The retained response is incomplete.'}
      </p>}
      {run.cleanupAcknowledgment && <p className="run-empty" data-cleanup-acknowledgment>Unreachable cleanup acknowledged locally. This does not confirm that the participant stopped or that provider work was cancelled.</p>}
      {cleanupState !== 'none' && <p className="run-empty" data-cleanup-state={cleanupState}>
        {run.cleanupAcknowledgment && cleanupState === 'unknown' ? 'Local cleanup remains unconfirmed. You can retry Stop or check this run if its original participant becomes reachable.'
          : cleanupState === 'cleared' ? `Local cleanup is confirmed. The recorded response outcome is unchanged.${run.phase === 'completed' || run.closure?.kind === 'interrupted' && run.closure.terminalEvent.type === 'completed' ? '' : ' Provider cancellation is not confirmed.'}`
          : cleanupState === 'unowned' ? 'The host no longer has a safe process handle. It cannot retry Stop for this response. Check the participant session directly; do not assume it has stopped.'
          : !canStop && stopState !== 'requesting' ? 'Local cleanup is not confirmed. Reconnect the original participant to check this response; do not assume it has stopped.'
          : 'The participant reported an end, but local cleanup is not confirmed. Retry Stop or check this run before sending another message.'}
      </p>}
      <article className="run-message" aria-label="Your message" data-message-id={run.userMessageId}>
        <h3>You</h3>
        <div className="run-message-text" dir="auto">{run.inputChunks.join('')}</div>
      </article>
      <article className="run-message" aria-label={`${run.participant.label} response`} data-message-id={run.assistantMessageId}>
        <h3>{run.participant.label}</h3>
        <dl className="run-participant">
          <div><dt>Model</dt><dd>{run.participant.model}</dd></div>
          <div><dt>Running on</dt><dd>{run.participant.executionHost}</dd></div>
        </dl>
        {output ? (
          <div className="run-message-text run-output" dir="auto" aria-live="off">
            {prefixMatches
              ? <><span data-saved-output="true">{savedOutput}</span><span data-pending-output="true"
                aria-describedby={pendingOutput ? pendingLabelId : undefined}>{pendingOutput}</span></>
              : output}
          </div>
        ) : <p className="run-empty">{emptyOutput}</p>}
      </article>
      <div className="run-save-state" aria-live="off" data-save-state={prefixMismatch ? 'unknown' : pending ? 'pending' : 'saved'}>
        <p>{saveLabel}</p>
        {saving && <p>Saving…</p>}
        {!prefixMismatch && pendingOutput && <p id={pendingLabelId}>Highlighted, dotted-underlined text is not yet saved.</p>}
      </div>
      {error && <p className="run-error" role="alert">{error}</p>}
    </section>
  );
}
