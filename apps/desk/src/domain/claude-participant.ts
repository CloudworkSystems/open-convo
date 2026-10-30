import type { ConversationRun, ParticipantIdentity } from './conversation-run-types';
import { ANTHROPIC_EXECUTION_HOST, CLAUDE_PARTICIPANT_ID } from './conversation-runs';
import { selectContext, type LocalContextResult } from './local-participant';

/**
 * Claude Code adapter PR 4a: the page's side of an off-Mac Claude run
 * (contract section 21). Pure helpers only: no transport, storage, consent
 * or provider choice lives here. Both consent gates are the Mac app's own.
 */

/** Section 17's first-trial bound, which section 21.2 counts over context plus the new message. */
export const CLAUDE_FIRST_TRIAL_BYTES = 4096;

/** Where an off-Mac Claude run goes, in the words every label uses. Never "stays on this Mac". */
export const CLAUDE_DESTINATION = 'Anthropic (not on this Mac)';

/** A revision-5 Claude Code pin: it sends off the Mac, to Anthropic. A revision-3 pin is not one. */
export function isOffMacClaude(identity: Readonly<ParticipantIdentity> | undefined | null): boolean {
  return identity?.id === CLAUDE_PARTICIPANT_ID && identity.executionHost === ANTHROPIC_EXECUTION_HOST;
}

/** The picker's name for the entry: "Claude · <model> · Anthropic (not on this Mac)". */
export function claudeChoiceTitle(identity: Readonly<ParticipantIdentity>): string {
  return `${identity.label} · ${identity.model} · ${CLAUDE_DESTINATION}`;
}

/**
 * The earlier turns an off-Mac Claude run sends: the session's earlier
 * completed turns, local or Claude, oldest whole turns left out so that they
 * and the new message fit `limit` together (section 21.2).
 */
export function selectClaudeContext(runs: readonly Readonly<ConversationRun>[], sessionId: string, input: string,
  limit = CLAUDE_FIRST_TRIAL_BYTES): LocalContextResult {
  return selectContext(runs, sessionId, input, limit);
}

/**
 * The line above the composer for an off-Mac Claude choice: what leaves
 * the Mac on Send, counted exactly as Send will pick it, local turns
 * included. Null when the message alone is past the bound (the composer
 * already says it is too long).
 */
export function claudeSendLine(runs: readonly Readonly<ConversationRun>[], sessionId: string, input: string,
  limit = CLAUDE_FIRST_TRIAL_BYTES): string | null {
  const context = selectClaudeContext(runs, sessionId, input, limit);
  if (context.kind !== 'ok') return null;
  const sent = context.contextRunIds.length;
  const earlier = runs.filter((run) => run.sessionId === sessionId && run.phase === 'completed').length;
  const turns = (count: number) => `${count} earlier ${count === 1 ? 'turn' : 'turns'}`;
  const line = sent ? `Sends this message and ${turns(sent)} to Anthropic.` : 'Sends this message to Anthropic, with no earlier turns.';
  const left = earlier - sent;
  return left > 0 ? `${line} ${left === 1 ? 'The oldest turn stays' : `The ${left} oldest turns stay`} on this Mac to fit the current trial’s limit.` : line;
}

/**
 * Retry (section 20.4) for an off-Mac Claude run, as for a local one: on a
 * cut-off, stopped or failed reply, never on a completed one. A revision-3
 * Claude pin has no Retry.
 */
export function canRetryClaudeRun(run: Readonly<ConversationRun>): boolean {
  if (!isOffMacClaude(run.participant)) return false;
  if (run.closure) return !(run.closure.kind === 'interrupted' && run.closure.terminalEvent.type === 'completed');
  return run.phase === 'stopped' || run.phase === 'failed';
}
