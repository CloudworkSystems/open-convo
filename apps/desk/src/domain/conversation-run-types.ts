/** Versioned, literal run records. These are sample-data proof records, not permission to send private context. */
export interface ParticipantIdentity {
  id: string;
  label: string;
  model: string;
  executionHost: string;
}

export type ConversationRunPhase = 'prepared' | 'running' | 'completed' | 'stopped' | 'failed' | 'unknown';
export type ParticipantStopReason = 'local-stop' | 'stop-incomplete' | 'reply-too-long' | 'paid-overflow' | 'timeout' | 'process-error';
export interface ConversationRun {
  version: 1;
  runId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  participant: ParticipantIdentity;
  inputChunks: string[];
  outputChunks: string[];
  lastSequence: number;
  phase: ConversationRunPhase;
  /**
   * The earlier completed runs of this session sent as context, oldest first.
   * Present exactly when `participant.id` is `ollama-local` (contract section
   * 20.3), or `claude-code` with `executionHost` `anthropic` (section 21.2),
   * possibly empty.
   */
  contextRunIds?: string[];
  createdAt: string;
  updatedAt: string;
  /** Native reason evidence belongs only to a stopped/failed phase. */
  reason?: ParticipantStopReason;
  /** Local closure preserves the last complete recorded prefix and event sequence. */
  closure?: ConversationRunClosure;
  /** Explicit local recovery choice; never evidence that a process stopped or cleared. */
  cleanupAcknowledgment?: { kind: 'unreachable'; at: string };
}

export type ParticipantEvent = {
  runId: string;
  sessionId: string;
  sequence: number;
  at: string;
} & (
  | { type: 'started' }
  | { type: 'text'; text: string }
  | { type: 'completed' }
  | { type: 'stopped'; reason?: ParticipantStopReason }
  | { type: 'failed'; reason?: ParticipantStopReason }
);

export type ParticipantTerminalEvent = Extract<ParticipantEvent, { type: 'completed' | 'stopped' | 'failed' }>;
export interface LostRange {
  fromSequence: number;
  throughSequence: number | null;
  reason: 'locked' | 'closed' | 'restarted' | 'replaced';
}

export type ConversationRunClosure =
  | { kind: 'unknown'; reason: 'user-closed'; at: string }
  | { kind: 'interrupted'; reason: 'event-refused' | 'workspace-limit'; at: string; terminalEvent: ParticipantTerminalEvent }
  | { kind: 'interrupted'; reason: 'replay-lost'; at: string; terminalEvent: ParticipantTerminalEvent; lost: LostRange };
